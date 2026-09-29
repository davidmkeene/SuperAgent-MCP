// doc-914 #7 (round 2 independent review, item 9): 6 of 13 mutants survived
// mutation testing because every test exercised persistTraceAndCapResponse
// directly, never the two real call sites in src/runner.ts that actually
// return a result to an MCP caller -- runCodexBatch (the modern path) and
// runBatch/resolveAgent (the legacy path). A mutant that reverted either
// call site back to `result.assistantReply || result.stdout` (the original
// bug: the full raw trace inlined whenever assistantReply was empty) passed
// every existing test.
//
// This mocks codexAgent.js's invokeCodex (the only thing either call site
// actually calls to get a result) via node:test's mock.module, so it
// exercises the REAL runCodexBatch/runBatch code, not a reimplementation of
// what they're supposed to do. Requires --experimental-test-module-mocks
// (see package.json's "test" script).
//
// mock.module only affects imports resolved AFTER it is installed, and
// dist/runner.js's own `import { invokeCodex } from "./codexAgent.js"`
// binding is fixed the first (and only, thanks to the ESM module cache)
// time runner.js is evaluated -- so the mock is installed ONCE, before
// runner.js is ever imported, and each test drives its fake invokeCodex
// through a shared mutable slot instead of re-mocking per test.
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

const { runCodexBatch, runBatch } = await import("../dist/runner.js");

function setFakeCodexResult({ assistantReply, stdout }) {
  nextFakeResult = { exitCode: 0, durationMs: 1, stdout, stderr: "", parsedEvents: [], assistantReply };
}

test("runCodexBatch never returns the raw trace inline when assistantReply is empty", async () => {
  setFakeCodexResult({ assistantReply: "", stdout: HUGE_STDOUT });
  const results = await runCodexBatch({ inputs: [{ prompt: "do the thing" }] });
  assert.equal(results.length, 1);
  const { response } = results[0];
  assert.ok(response.length < 8100, `response must stay capped, was ${response.length} chars`);
  assert.ok(!response.includes("x".repeat(1000)), "the raw trace body must never appear inline");
  assert.match(response, /\[full trace: \d+ chars written to .*\.log\]$/);
});

test("runCodexBatch caps a pathologically long assistantReply too, not just an empty one", async () => {
  const longReply = "y".repeat(50_000);
  setFakeCodexResult({ assistantReply: longReply, stdout: longReply });
  const results = await runCodexBatch({ inputs: [{ prompt: "do the thing" }] });
  const { response } = results[0];
  assert.ok(response.length < 8100, `response must stay capped, was ${response.length} chars`);
  assert.ok(response.includes("[truncated]"));
});

test("runCodexBatch passes a normal short reply through, still trace-noted", async () => {
  setFakeCodexResult({ assistantReply: "PONG", stdout: '{"type":"item.completed"}\n' });
  const results = await runCodexBatch({ inputs: [{ prompt: "ping" }] });
  assert.ok(results[0].response.startsWith("PONG"));
});

test("runBatch (legacy resolveAgent path, agentEnv=codex) never returns the raw trace inline", async () => {
  setFakeCodexResult({ assistantReply: "", stdout: HUGE_STDOUT });
  const results = await runBatch({ agentEnv: "codex", prompts: [{ prompt: "do the thing" }] });
  assert.equal(results.length, 1);
  const { response } = results[0];
  assert.ok(response.length < 8100, `response must stay capped, was ${response.length} chars`);
  assert.ok(!response.includes("x".repeat(1000)), "the raw trace body must never appear inline");
});

test("runBatch (legacy path) caps a pathologically long assistantReply too", async () => {
  const longReply = "y".repeat(50_000);
  setFakeCodexResult({ assistantReply: longReply, stdout: longReply });
  const results = await runBatch({ agentEnv: "codex", prompts: [{ prompt: "do the thing" }] });
  const { response } = results[0];
  assert.ok(response.length < 8100, `response must stay capped, was ${response.length} chars`);
  assert.ok(response.includes("[truncated]"));
});
