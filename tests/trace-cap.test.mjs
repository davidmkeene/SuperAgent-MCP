// doc-914 #7: cap the inline response and persist the full trace to disk,
// so a caller with no parsed final message (or a pathologically long one)
// cannot blow the MCP transport's own result-size limit the way a raw
// 72k-441k char trace used to.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistTraceAndCapResponse } from "../dist/runner.js";

test("a normal short reply is passed through with a trace-file note appended", () => {
  const out = persistTraceAndCapResponse("codex", "OK", '{"type":"item.completed"}\n'.repeat(3));
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
  const dir = mkdtempSync(join(tmpdir(), "superagent-trace-fail-"));
  const readonlyDir = join(dir, "readonly");
  mkdirSync(readonlyDir, { mode: 0o500 });
  const original = process.env.SUPERAGENT_TRACE_DIR;
  // A path UNDER a read-only directory: mkdirSync({recursive:true}) for the
  // nested trace dir itself must fail with EACCES there (root can bypass
  // this permission bit, so the assertion below tolerates either outcome).
  process.env.SUPERAGENT_TRACE_DIR = join(readonlyDir, "nested", "traces");
  try {
    const out = persistTraceAndCapResponse("codex", "reply text", "trace body");
    assert.ok(out.startsWith("reply text"));
    assert.ok(out.includes("NOT persisted") || out.includes("written to"),
      "either persisted (e.g. running as root, which bypasses the permission bit) " +
      "or explicitly said it could not be -- never silent, never the raw trace");
  } finally {
    if (original === undefined) delete process.env.SUPERAGENT_TRACE_DIR;
    else process.env.SUPERAGENT_TRACE_DIR = original;
    chmodSync(readonlyDir, 0o700);
  }
});
