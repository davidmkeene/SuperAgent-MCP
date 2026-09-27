import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The single place this server defines default models. Nothing else in the
 * server may hard-code a model name as a default, and no tool description may
 * present a model as recommended or verified: descriptions tell callers to
 * leave `model` unset.
 *
 * Codex and Gemini: this server sets NO default. The CLI decides (Codex reads
 * `model` from $CODEX_HOME/config.toml, default ~/.codex/config.toml).
 */
export const GROK_DEFAULT_MODEL = "grok-4.7"; // operator selection, 2026-09-21
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-pro";
export const OLLAMA_DEFAULT_MODEL = "qwen3:30b-a3b"; // used only when the fleet router returns no model

export const SERVER_DEFAULT_SOURCE = "superagent default (src/modelDefaults.ts)";

export interface ModelUsed {
  id: string | null;
  source: string;
}

function codexConfigPath(env: NodeJS.ProcessEnv): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

/** Top-level `model = "..."` in the Codex config (keys before the first [table]). */
export function codexConfiguredModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  let text: string;
  try {
    text = readFileSync(codexConfigPath(env), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*model\s*=\s*["']([^"']+)["']/);
    if (m) return m[1];
  }
  return undefined;
}

/** A model forced through extraArgs (-m/--model/-c model=...) wins over config. */
function modelFromArgs(args: string[] | undefined): string | undefined {
  if (!args) return undefined;
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "-m" || a === "--model") && args[i + 1]) found = args[i + 1];
    else if (a.startsWith("--model=")) found = a.slice(8);
    else if ((a === "-c" || a === "--config") && /^model\s*=/.test(args[i + 1] ?? "")) {
      found = args[i + 1].replace(/^model\s*=\s*/, "").replace(/^["']|["']$/g, "");
    }
  }
  return found;
}

export function codexModelUsed(requested: string | undefined, extraArgs?: string[], env: NodeJS.ProcessEnv = process.env): ModelUsed {
  const fromArgs = modelFromArgs(extraArgs);
  if (fromArgs) return { id: fromArgs, source: "request (extraArgs)" };
  if (requested) return { id: requested, source: "request" };
  const configured = codexConfiguredModel(env);
  if (configured) {
    return { id: configured, source: env.CODEX_HOME ? "codex config.toml (CODEX_HOME)" : "codex config.toml (~/.codex)" };
  }
  return { id: null, source: "codex CLI built-in default (not reported in the event stream)" };
}

export function grokModelUsed(requested: string | undefined): ModelUsed {
  return requested ? { id: requested, source: "request" } : { id: GROK_DEFAULT_MODEL, source: SERVER_DEFAULT_SOURCE };
}
