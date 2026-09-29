// doc-914 (round 2 review, item 10): this live-install branch has a THIRD
// uncapped codex fallback, only here -- runMultiBatch/runChain, via
// invokeSingleTask's `case "codex"` (`r.assistantReply || r.stdout`), which
// does not exist upstream at all (runMultiBatch/runChain are branch-local
// features), so the upstream trace-cap fix never touched it. Same class of
// bug as runCodexBatch/runBatch's two fallbacks: the full raw trace inlined
// whenever assistantReply came back empty.
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const HUGE_STDOUT = "x".repeat(300_000);

let nextFakeResult = { exitCode: 0, durationMs: 1, stdout: "", stderr: "", parsedEvents: [], assistantReply: "" };

mock.module("../dist/codexAgent.js", {
  exports: {
    invokeCodex: async () => nextFakeResult,
    CodexInvocationError: class CodexInvocationError extends Error {},
  },
});

const { runMultiBatch, runChain } = await import("../dist/runner.js");

function setFakeCodexResult({ assistantReply, stdout }) {
  nextFakeResult = { exitCode: 0, durationMs: 1, stdout, stderr: "", parsedEvents: [], assistantReply };
}

test("runMultiBatch (codex provider) never returns the raw trace inline when assistantReply is empty", async () => {
  setFakeCodexResult({ assistantReply: "", stdout: HUGE_STDOUT });
  const results = await runMultiBatch({
    inputs: [{ provider: "codex", prompt: "do the thing" }],
    concurrency: 1,
  });
  assert.equal(results.length, 1);
  const { response } = results[0];
  assert.ok(response.length < 8100, `response must stay capped, was ${response.length} chars`);
  assert.ok(!response.includes("x".repeat(1000)), "the raw trace body must never appear inline");
  assert.match(response, /\[full trace: \d+ chars written to .*\.log\]$/);
});

test("runMultiBatch (codex provider) caps a pathologically long assistantReply too", async () => {
  const longReply = "y".repeat(50_000);
  setFakeCodexResult({ assistantReply: longReply, stdout: longReply });
  const results = await runMultiBatch({
    inputs: [{ provider: "codex", prompt: "do the thing" }],
    concurrency: 1,
  });
  const { response } = results[0];
  assert.ok(response.length < 8100, `response must stay capped, was ${response.length} chars`);
  assert.ok(response.includes("[truncated]"));
});

test("runMultiBatch (codex provider) passes a normal short reply through, still trace-noted", async () => {
  setFakeCodexResult({ assistantReply: "PONG", stdout: '{"type":"item.completed"}\n' });
  const results = await runMultiBatch({
    inputs: [{ provider: "codex", prompt: "ping" }],
    concurrency: 1,
  });
  assert.ok(results[0].response.startsWith("PONG"));
});

test("runChain (codex step) never returns the raw trace inline when assistantReply is empty", async () => {
  setFakeCodexResult({ assistantReply: "", stdout: HUGE_STDOUT });
  const results = await runChain({
    steps: [{ provider: "codex", prompt: "do the thing" }],
  });
  assert.equal(results.length, 1);
  const { response } = results[0];
  assert.ok(response.length < 8100, `response must stay capped, was ${response.length} chars`);
  assert.ok(!response.includes("x".repeat(1000)), "the raw trace body must never appear inline");
});
