// End-to-end tests through the MCP server over stdio, with fake provider CLIs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, writeFileSync, utimesSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, withServer, fixturePath } from "./helpers.mjs";

const call = (sb, tool, input, extraEnv = {}) =>
  withServer(sb.env(extraEnv), (c) => c.callTool(tool, { inputs: [input] }));
const parse = (text) => JSON.parse(text);

test("codex success: compact result with final message, usage, model, trace path", async () => {
  const sb = makeSandbox();
  const text = await call(sb, "codex", { prompt: "reply with the single word ok" },
    { FAKE_STDOUT_FILE: fixturePath("codex-small-success.jsonl") });
  const out = parse(text);
  const r = out.results[0];
  assert.equal(r.status, "ok");
  assert.equal(r.final_message, "OK");
  assert.deepEqual(r.usage, { input_tokens: 13538, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 });
  assert.equal(r.exit_code, 0);
  assert.equal(typeof r.duration_ms, "number");
  assert.deepEqual(r.model, { id: "fixture-config-default-model", source: "codex config.toml (CODEX_HOME)" });
  assert.ok(r.trace_path.startsWith(sb.traceDir), r.trace_path);
  assert.ok(readFileSync(r.trace_path, "utf8").includes('"type":"turn.completed"'));
  assert.equal(statSync(r.trace_path).mode & 0o777, 0o600);
  // Model unset => no -m passed to the CLI.
  const argv = JSON.parse(readFileSync(sb.argsFile, "utf8"));
  assert.ok(!argv.includes("-m") && !argv.includes("--model"), argv.join(" "));
  assert.ok(text.length < 2000, `result is ${text.length} chars`);
});

test("codex explicit model is passed through and reported as the model used", async () => {
  const sb = makeSandbox();
  const out = parse(await call(sb, "codex", { prompt: "x", model: "operator-named-model" },
    { FAKE_STDOUT_FILE: fixturePath("codex-small-success.jsonl") }));
  assert.deepEqual(out.results[0].model, { id: "operator-named-model", source: "request" });
  const argv = JSON.parse(readFileSync(sb.argsFile, "utf8"));
  assert.deepEqual(argv.slice(argv.indexOf("-m"), argv.indexOf("-m") + 2), ["-m", "operator-named-model"]);
});

test("codex provider rejects model: clear error naming the model, no raw 400 dump", async () => {
  const sb = makeSandbox();
  const model = "superagent-nonexistent-model-probe";
  const text = await call(sb, "codex", { prompt: "x", model },
    { FAKE_STDOUT_FILE: fixturePath("codex-model-rejected.jsonl"), FAKE_EXIT: "1" });
  const r = parse(text).results[0];
  assert.equal(r.status, "error");
  assert.equal(r.error_kind, "model_rejected");
  assert.match(r.error, new RegExp(`Codex rejected model '${model}'`));
  assert.match(r.error, /omit model to use the provider default/);
  assert.match(r.error, /not supported when using Codex with a ChatGPT account/);
  assert.ok(!r.error.includes('{"type":"error"'), r.error);
  assert.deepEqual(Object.keys(r.last_error_event).sort(), ["message", "status", "type"]);
  assert.equal(r.last_error_event.status, 400);
  assert.equal(r.exit_code, 1);
  assert.ok(existsSync(r.trace_path));
  assert.equal(r.provider, "codex", "must not be replaced by an ollama fallback");
});

test("codex non-zero exit: last 2,000 chars of stderr plus trace path", async () => {
  const sb = makeSandbox();
  const r = parse(await call(sb, "codex", { prompt: "x" },
    { FAKE_STDOUT: "", FAKE_STDERR: "boom-0123456789\n", FAKE_STDERR_REPEAT: "500", FAKE_EXIT: "2" })).results[0];
  assert.equal(r.status, "error");
  assert.equal(r.exit_code, 2);
  assert.match(r.error, /Codex exited with code 2/);
  assert.equal(r.stderr_tail.length, 2000);
  assert.ok("boom-0123456789\n".repeat(500).endsWith(r.stderr_tail));
  assert.ok(readFileSync(r.trace_path, "utf8").includes("boom-0123456789"));
});

test("codex empty final message: ok with a note, never the raw stream", async () => {
  const sb = makeSandbox();
  const text = await call(sb, "codex", { prompt: "x" }, { FAKE_STDOUT_FILE: fixturePath("codex-empty-final.jsonl") });
  const r = parse(text).results[0];
  assert.equal(r.status, "ok");
  assert.equal(r.final_message, "");
  assert.match(r.note, /no agent_message/);
  assert.ok(!text.includes("command_execution"), "raw events leaked into the result");
  assert.deepEqual(r.usage, { input_tokens: 900, cached_input_tokens: 100, output_tokens: 12, reasoning_output_tokens: 4 });
  assert.equal(r.commands.count, 1);
});

test("codex very large stream (recorded, 293 KB): summary under 2.5 KB; trace holds all of it", async () => {
  const sb = makeSandbox();
  const stream = readFileSync(fixturePath("codex-large-success.jsonl"), "utf8");
  const text = await call(sb, "codex", { prompt: "x" }, { FAKE_STDOUT_FILE: fixturePath("codex-large-success.jsonl") });
  const r = parse(text).results[0];
  assert.equal(r.final_message, "SANITISED FINAL MESSAGE: task complete, 2 files changed.");
  assert.deepEqual(r.usage, { input_tokens: 854945, cached_input_tokens: 769152, cache_write_input_tokens: 0, output_tokens: 8781, reasoning_output_tokens: 398 });
  assert.deepEqual(r.files_changed, [{ path: "src/sanitised/file1.ts", kind: "add" }]);
  assert.equal(r.commands.count, 21);
  assert.ok(text.length < 2500, `result is ${text.length} chars`);
  assert.ok(readFileSync(r.trace_path, "utf8").includes(stream));
  console.log(`# large fixture: stream ${stream.length} chars -> result ${text.length} chars`);
});

test("codex trace:'full' returns the complete event stream for callers who need it", async () => {
  const sb = makeSandbox();
  const stream = readFileSync(fixturePath("codex-large-success.jsonl"), "utf8");
  const r = parse(await call(sb, "codex", { prompt: "x", trace: "full" },
    { FAKE_STDOUT_FILE: fixturePath("codex-large-success.jsonl") })).results[0];
  assert.equal(r.raw_stdout, stream);
  assert.equal(r.final_message, "SANITISED FINAL MESSAGE: task complete, 2 files changed.");
});

test("multi and chain use the final message for codex, not the raw stream", async () => {
  const sb = makeSandbox();
  const env = sb.env({ FAKE_STDOUT_FILE: fixturePath("codex-large-success.jsonl") });
  const [multi, chain] = await withServer(env, async (c) => [
    await c.callTool("multi", { inputs: [{ provider: "codex", prompt: "x" }] }),
    await c.callTool("chain", { steps: [{ provider: "codex", prompt: "x" }] })
  ]);
  for (const text of [multi, chain]) {
    assert.ok(text.includes("SANITISED FINAL MESSAGE"), text.slice(0, 300));
    assert.ok(text.length < 2500, `result is ${text.length} chars`);
    assert.match(text, /Trace: .*codex-/);
  }
});

test("grok: compact result with configured default model, trace path, usage null", async () => {
  const sb = makeSandbox();
  const r = parse(await call(sb, "grok", { prompt: "x" }, { FAKE_STDOUT: "hello from grok\n" })).results[0];
  assert.equal(r.status, "ok");
  assert.equal(r.final_message, "hello from grok");
  assert.equal(r.model.source, "superagent default (src/modelDefaults.ts)");
  const argv = JSON.parse(readFileSync(sb.argsFile, "utf8"));
  assert.equal(argv[argv.indexOf("-m") + 1], r.model.id);
  assert.equal(r.usage, null);
  assert.ok(existsSync(r.trace_path));
});

test("grok provider rejects model: clear error with omit-model guidance", async () => {
  const sb = makeSandbox();
  const r = parse(await call(sb, "grok", { prompt: "x", model: "grok-nope" },
    { FAKE_STDOUT: "", FAKE_STDERR: "Error: model 'grok-nope' not found (400 Bad Request)\n", FAKE_EXIT: "1" })).results[0];
  assert.equal(r.status, "error");
  assert.equal(r.error_kind, "model_rejected");
  assert.match(r.error, /Grok rejected model 'grok-nope'.*omit model to use the provider default/s);
});

test("trace retention prunes files older than the retention window", async () => {
  const sb = makeSandbox();
  mkdirSync(sb.traceDir, { recursive: true });
  const old = join(sb.traceDir, "codex-old.log");
  writeFileSync(old, "old");
  const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  utimesSync(old, past, past);
  await call(sb, "codex", { prompt: "x" }, { FAKE_STDOUT_FILE: fixturePath("codex-small-success.jsonl") });
  assert.ok(!existsSync(old), "old trace should be pruned");
  assert.equal(readdirSync(sb.traceDir).length, 1);
});

test("tool descriptions recommend no model and tell callers to omit model", async () => {
  const sb = makeSandbox();
  const tools = await withServer(sb.env(), (c) => c.listTools());
  const all = JSON.stringify(tools);
  for (const banned of [/USE THIS/, /VERIFIED WORKING/i, /gpt-5\.3-codex/, /\bprefer\b[^.]*\b(model|v4|grok|gpt)/i, /\bDEFAULT\)/, /Use v4-pro/i]) {
    assert.ok(!banned.test(all), `tool metadata matches ${banned}`);
  }
  const codex = tools.find((t) => t.name === "codex");
  assert.match(codex.description, /[Ll]eave `model` unset to use the provider default/);
  assert.match(codex.description, /only if the operator has named one/);
  assert.ok(codex.inputSchema.properties.inputs.items.properties.trace, "trace parameter missing");
});
