// doc-914 #7 (round 2 independent review): the real cause was that
// codexAgent.ts's reply parser only ever recognised the LEGACY
// `{msg:{type:"agent_message"}}` event shape. Current codex-cli (0.4x ..
// 0.157+, observed live) emits `{"type":"item.completed","item":{"type":
// "agent_message","text":...}}` instead -- the parser never matched it, so
// `assistantReply` was ALWAYS empty against a current CLI, and every caller
// fell back to `result.stdout` (the full raw trace: 72k-441k characters,
// three times in one session per doc 914's own table).
//
// These fixtures are real codex-cli --json event streams (sanitised of
// content, not of shape) captured from a live run; codex-large-success.jsonl
// alone is 286KB / 53 lines, close to the actual sizes doc 914 reported.
//
// Run against the COMPILED output (`npm run build` first, same convention
// this repo already uses): `node --test tests/`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readFileSync as rf } from "node:fs";
import { parseAssistantReply, parseJsonLines } from "../dist/codexAgent.js";
import { fixturePath } from "./helpers.mjs";

function loadEvents(name) {
  const raw = readFileSync(fixturePath(name), "utf8");
  return parseJsonLines(raw);
}

test("modern item.completed shape: a single agent_message is the reply, not the raw trace", () => {
  const events = loadEvents("codex-small-success.jsonl");
  const reply = parseAssistantReply(events);
  assert.equal(reply, "OK");
});

test("modern item.completed shape: only the LAST agent_message is returned, not every one", () => {
  const events = loadEvents("codex-large-success.jsonl");
  const reply = parseAssistantReply(events);
  assert.equal(reply, "SANITISED FINAL MESSAGE: task complete, 2 files changed.");
  // The reply must be small -- not a concatenation of the whole trace.
  assert.ok(reply.length < 200, `reply should be short, was ${reply.length} chars`);
  const rawStdout = rf(fixturePath("codex-large-success.jsonl"), "utf8");
  assert.ok(rawStdout.length > 250_000, "fixture itself should be large (sanity check)");
});

test("a turn with no agent_message at all (only tool calls) parses to an empty reply, not garbage", () => {
  const events = loadEvents("codex-empty-final.jsonl");
  const reply = parseAssistantReply(events);
  assert.equal(reply, "");
});

test("legacy {msg:{type:agent_message}} shape still parses (older CLI)", () => {
  const events = loadEvents("codex-legacy-msg-shape.jsonl");
  const reply = parseAssistantReply(events);
  assert.equal(reply, "legacy shape final reply");
});

test("a mix of unrelated event types alongside item.completed does not corrupt the reply", () => {
  const stream = [
    { type: "thread.started", thread_id: "x" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "item_0", type: "command_execution" } },
    { type: "item.completed", item: { id: "item_0", type: "command_execution", exit_code: 0 } },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "final answer" } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const events = parseJsonLines(stream);
  assert.equal(parseAssistantReply(events), "final answer");
});
