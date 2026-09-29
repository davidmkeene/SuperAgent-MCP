// doc-914 #7: cap the inline response and persist the full trace to disk,
// so a caller with no parsed final message (or a pathologically long one)
// cannot blow the MCP transport's own result-size limit the way a raw
// 72k-441k char trace used to.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, chmodSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistTraceAndCapResponse, cleanupOldTraces } from "../dist/runner.js";

// doc-914 (round 2 review, item 9): a trace file is only worth writing when
// the raw trace would not have fit inline anyway -- a short reply from a
// short trace needs no on-disk artifact at all. Previously EVERY call wrote
// one, regardless of size.
test("a normal short reply from a short trace needs no trace file at all", () => {
  const out = persistTraceAndCapResponse("codex", "OK", '{"type":"item.completed"}\n'.repeat(3));
  assert.equal(out, "OK");
  assert.ok(!out.includes("full trace"), "no trace note for content that already fits inline");
});

test("a short reply from an over-cap trace still writes and notes the trace file", () => {
  const hugeTrace = "x".repeat(300_000);
  const out = persistTraceAndCapResponse("codex", "OK", hugeTrace);
  assert.ok(out.startsWith("OK"));
  assert.match(out, /\[full trace: \d+ chars written to .*\.log\]$/);
  const m = out.match(/written to (\S+\.log)/);
  assert.ok(existsSync(m[1]), "trace file should actually exist on disk");
});

test("an empty assistantReply gets a placeholder, never the raw trace inline", () => {
  const hugeTrace = "x".repeat(300_000);
  const out = persistTraceAndCapResponse("codex", "", hugeTrace);
  assert.ok(out.includes("no parsed final message"));
  assert.ok(out.length < 8100, `response must stay near MAX_RESPONSE_CHARS, was ${out.length}`);
  assert.ok(!out.includes("x".repeat(1000)), "the raw trace body must never appear inline");
});

test("a pathologically long final message is truncated, not returned whole", () => {
  const longReply = "y".repeat(50_000);
  const out = persistTraceAndCapResponse("codex", longReply, longReply);
  assert.ok(out.length < 8100, `response must stay near MAX_RESPONSE_CHARS, was ${out.length}`);
  assert.ok(out.includes("[truncated]"));
});

test("trace persistence failure degrades to a note, never throws or falls back to inlining the trace", () => {
  // TRACE_DIR is fixed at module-load time (a `const`), so a
  // process.env.SUPERAGENT_TRACE_DIR mutation here would never actually
  // reach it -- persistTraceAndCapResponse takes an explicit `traceDir`
  // override for exactly this (same pattern as cleanupOldTraces' `dir`).
  const dir = mkdtempSync(join(tmpdir(), "superagent-trace-fail-"));
  const readonlyDir = join(dir, "readonly");
  mkdirSync(readonlyDir, { mode: 0o500 });
  try {
    // A path UNDER a read-only directory: mkdirSync({recursive:true}) for
    // the nested trace dir itself must fail with EACCES there (root can
    // bypass this permission bit, so the assertion below tolerates either
    // outcome). The trace body must exceed MAX_RESPONSE_CHARS -- otherwise
    // persistTraceAndCapResponse never attempts a write at all (see the
    // "needs no trace file at all" test above).
    const hugeTrace = "x".repeat(300_000);
    const nestedDir = join(readonlyDir, "nested", "traces");
    const out = persistTraceAndCapResponse("codex", "reply text", hugeTrace, nestedDir);
    assert.ok(out.startsWith("reply text"));
    assert.ok(out.includes("NOT persisted") || out.includes("written to"),
      "either persisted (e.g. running as root, which bypasses the permission bit) " +
      "or explicitly said it could not be -- never silent, never the raw trace");
    if (out.includes("NOT persisted")) {
      assert.ok(!out.includes("x".repeat(1000)), "the raw trace body must never appear inline");
    }
  } finally {
    chmodSync(readonlyDir, 0o700);
  }
});

// doc-914 (round 2 review, item 9): trace files are write-once debugging
// artifacts under a per-user cache directory with no other rotation --
// cleanupOldTraces() sweeps anything older than 7 days at server start-up.

test("cleanupOldTraces removes only files older than 7 days", () => {
  // TRACE_DIR is read from SUPERAGENT_TRACE_DIR once at module load, so a
  // later env override would not affect the already-imported module --
  // cleanupOldTraces takes an explicit `dir` override for exactly this.
  const dir = mkdtempSync(join(tmpdir(), "superagent-trace-cleanup-"));
  const oldFile = join(dir, "codex-old.log");
  const freshFile = join(dir, "codex-fresh.log");
  writeFileSync(oldFile, "old trace");
  writeFileSync(freshFile, "fresh trace");
  const now = Date.now();
  const eightDaysAgoSec = (now - 8 * 24 * 60 * 60 * 1000) / 1000;
  const oneDayAgoSec = (now - 1 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(oldFile, eightDaysAgoSec, eightDaysAgoSec);
  utimesSync(freshFile, oneDayAgoSec, oneDayAgoSec);

  cleanupOldTraces(now, dir);

  const remaining = readdirSync(dir);
  assert.ok(!remaining.includes("codex-old.log"), "an 8-day-old trace must be removed");
  assert.ok(remaining.includes("codex-fresh.log"), "a 1-day-old trace must survive");
});

test("cleanupOldTraces on a directory that does not exist yet is a silent no-op", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "superagent-trace-cleanup-")), "does-not-exist");
  assert.doesNotThrow(() => cleanupOldTraces(Date.now(), dir));
});
