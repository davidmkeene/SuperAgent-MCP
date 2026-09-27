import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeCodexStream, unwrapProviderError, isModelRejection } from "../dist/codexEvents.js";
import { codexModelUsed } from "../dist/modelDefaults.js";
import { fixturePath } from "./helpers.mjs";

test("unwraps the provider's nested 400 JSON to its message and status", () => {
  const ev = readFileSync(fixturePath("codex-model-rejected.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
  const e = unwrapProviderError(ev.error.message);
  assert.equal(e.status, 400);
  assert.equal(e.type, "invalid_request_error");
  assert.match(e.message, /^The 'superagent-nonexistent-model-probe' model is not supported/);
});

test("the benign 'Model metadata not found' warning alone is not a rejection", () => {
  const warning = "Model metadata for `x` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";
  assert.equal(isModelRejection(undefined, warning), false);
  assert.equal(isModelRejection({ type: "error", message: "rate limit exceeded, retry later" }), false);
  assert.equal(isModelRejection({ type: "error", status: 500, message: "internal error" }), false);
  assert.equal(isModelRejection({ type: "invalid_request_error", status: 400, message: "The 'y' model does not exist" }), true);
});

test("usage is summed across turns; legacy agent_message shape still read", () => {
  const stream = [
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1, reasoning_output_tokens: 3 } },
    { msg: { type: "agent_message", message: "legacy reply" } }
  ].map((e) => JSON.stringify(e)).join("\n");
  const s = summarizeCodexStream(stream);
  assert.deepEqual(s.usage, { input_tokens: 15, output_tokens: 3, reasoning_output_tokens: 3 });
  assert.equal(s.finalMessage, "legacy reply");
});

test("model used: extraArgs beat model beat config; missing config says so", () => {
  const env = { CODEX_HOME: "/nonexistent-codex-home" };
  assert.deepEqual(codexModelUsed(undefined, undefined, env), { id: null, source: "codex CLI built-in default (not reported in the event stream)" });
  assert.deepEqual(codexModelUsed("a", ["-c", "model=b"], env), { id: "b", source: "request (extraArgs)" });
  assert.deepEqual(codexModelUsed("a", [], env), { id: "a", source: "request" });
});
