// Test helpers: fake provider CLIs and a minimal MCP stdio client.
// No test in this directory starts a real Codex or Grok process.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES = join(ROOT, "tests", "fixtures");
export const fixturePath = (name) => join(FIXTURES, name);

// A fake CLI: prints FAKE_STDOUT_FILE to stdout, FAKE_STDERR (or
// FAKE_STDERR_REPEAT copies of it) to stderr, records argv, exits FAKE_EXIT.
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("fs");
if (process.env.FAKE_ARGS_FILE) fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
process.stdin.resume(); process.stdin.on("data", () => {});
process.stdin.on("end", finish); setTimeout(finish, 200);
let done = false;
function finish() {
  if (done) return; done = true;
  const out = process.env.FAKE_STDOUT_FILE ? fs.readFileSync(process.env.FAKE_STDOUT_FILE, "utf8") : (process.env.FAKE_STDOUT || "");
  const err = (process.env.FAKE_STDERR || "").repeat(Number(process.env.FAKE_STDERR_REPEAT || 1));
  process.stdout.write(out, () => process.stderr.write(err, () => process.exit(Number(process.env.FAKE_EXIT || 0))));
}
`;

export function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "superagent-test-"));
  const cli = join(dir, "fake-cli.cjs");
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);
  const codexHome = join(dir, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), 'model = "fixture-config-default-model"\nmodel_reasoning_effort = "low"\n\n[projects."/x"]\nmodel = "not-top-level"\n');
  const home = join(dir, "home");
  mkdirSync(home);
  return {
    dir,
    cli,
    traceDir: join(dir, "traces"),
    argsFile: join(dir, "args.json"),
    env(extra = {}) {
      return {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: codexHome,
        CODEX_PATH: cli,
        GROK_PATH: cli,
        SUPERAGENT_TRACE_DIR: join(dir, "traces"),
        SUPERAGENT_OLLAMA_FALLBACK: "false",
        FAKE_ARGS_FILE: join(dir, "args.json"),
        ...extra
      };
    }
  };
}

// Spawn a server build and talk MCP over stdio. `serverJs` defaults to this
// worktree's dist/server.js.
export async function withServer(env, fn, serverJs = join(ROOT, "dist", "server.js")) {
  const child = spawn(process.execPath, [serverJs], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.on("data", () => {});
  let nextId = 1;
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await fn({
      listTools: async () => (await request("tools/list", {})).result.tools,
      callTool: async (name, args) => {
        const res = await request("tools/call", { name, arguments: args });
        if (res.error) throw new Error(JSON.stringify(res.error));
        return res.result.content.map((c) => c.text).join("\n");
      }
    });
  } finally {
    child.kill();
  }
}
