import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CliProvider = "codex" | "grok" | "gemini";
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  usage_known: boolean;
  reason?: string;
  observed_total_tokens?: number;
  source: string;
  model?: string;
}

export function unknownUsage(source: string, reason: string): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, usage_known: false, source, reason: `${source}: ${reason}` };
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function counters(raw: any, source: string): Usage {
  if (!raw || typeof raw !== "object") return unknownUsage(source, "missing terminal usage");
  const input = raw.input_tokens;
  const output = raw.output_tokens;
  const cached = raw.cached_input_tokens ?? raw.cache_read_input_tokens ?? 0;
  const created = raw.cache_creation_input_tokens ?? raw.cache_write_input_tokens ?? 0;
  if (![input, output, cached, created].every(counter)) {
    return unknownUsage(source, "missing or invalid token counters");
  }
  // Copy the literal counters, as reo_provider_launcher does. Do not subtract
  // cached input here: REO's pricing layer handles the provider's cache rules.
  return { input_tokens: input, output_tokens: output, cache_read_input_tokens: cached,
    cache_creation_input_tokens: created, usage_known: true, source };
}

function jsonEvents(stdout: string): any[] {
  try {
    const value = JSON.parse(stdout);
    return Array.isArray(value) ? value : [value];
  } catch { /* JSONL, possibly with CLI diagnostics */ }
  return stdout.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function parseUsage(provider: CliProvider, stdout: string, stderr = ""): Usage[] {
  const events = jsonEvents(stdout).filter(e => e && typeof e === "object");
  if (provider === "codex") {
    const terminal = events.filter(e => e.type === "turn.completed");
    if (terminal.length === 1) return [counters(terminal[0].usage, "codex/json/turn.completed")];
    if (terminal.length > 1) return [unknownUsage("codex/json", "multiple terminal events; refusing ambiguous totals")];
    const text = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
    const matches = [...text.matchAll(/^tokens used\s*\r?\n([\d,]+)\s*$/gm)];
    if (matches.length === 1) {
      const total = Number(matches[0][1].replaceAll(",", ""));
      const usage = unknownUsage("codex/text/tokens-used", "footer does not provide input/output/cache split; use --json");
      if (counter(total)) usage.observed_total_tokens = total;
      return [usage];
    }
    return [unknownUsage("codex/json", "no terminal turn.completed usage (failed, truncated, or text-only run)")];
  }
  if (provider === "grok") {
    const terminal = events.filter(e => e.type === "result" || e.stopReason === "end_turn");
    if (terminal.length !== 1) return [unknownUsage("grok/terminal", "no unique structured result in CLI output")];
    const row = terminal[0];
    if (row.modelUsage && typeof row.modelUsage === "object" && Object.keys(row.modelUsage).length) {
      const models = Object.entries(row.modelUsage);
      // Current Grok builds can attest a model with an empty modelUsage
      // object while exposing the actual counters only in top-level usage.
      if (models.length === 1 && (models[0][1] as any)?.inputTokens === undefined && (models[0][1] as any)?.input_tokens === undefined) {
        return [{ ...counters(row.usage, "grok/result/usage"), model: models[0][0] }];
      }
      return Object.entries(row.modelUsage).map(([model, raw]: [string, any]) => ({
        ...counters({ input_tokens: raw?.inputTokens ?? raw?.input_tokens, output_tokens: raw?.outputTokens ?? raw?.output_tokens,
          cache_read_input_tokens: raw?.cacheReadInputTokens ?? raw?.cache_read_input_tokens,
          cache_creation_input_tokens: raw?.cacheCreationInputTokens ?? raw?.cache_creation_input_tokens }, "grok/result/modelUsage"), model
      }));
    }
    return [{ ...counters(row.usage, "grok/result/usage"), model: typeof row.model === "string" ? row.model : undefined }];
  }
  const terminal = events.filter(e => e.stats?.models);
  if (terminal.length !== 1) return [unknownUsage("gemini/json/stats.models", "no unique terminal model stats")];
  const rows = Object.entries(terminal[0].stats.models).map(([model, stats]: [string, any]) => {
    const tokens = stats?.tokens;
    // Gemini telemetry defines input = prompt - cached. Preserve the full
    // provider prompt counter and include reasoning in billed output.
    const input = tokens?.prompt ?? (counter(tokens?.input) && counter(tokens?.cached ?? 0)
      ? tokens.input + (tokens.cached ?? 0) : undefined);
    const output = counter(tokens?.candidates) && counter(tokens?.thoughts ?? 0)
      ? tokens.candidates + (tokens.thoughts ?? 0) : undefined;
    return { ...counters({ input_tokens: input, output_tokens: output,
      cache_read_input_tokens: tokens?.cached }, "gemini/json/stats.models"), model };
  });
  return rows.length ? rows : [unknownUsage("gemini/json/stats.models", "empty model stats")];
}

// Read only a top-level string; never accidentally use a model from an MCP or
// project table. An unsupported/malformed value remains unknown, not an alias.
export function configuredCodexModel(configPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml")): string | undefined {
  try {
    const top = readFileSync(configPath, "utf8").split(/^\s*\[/m)[0];
    const match = top.match(/^\s*model\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/m);
    if (!match) return undefined;
    const value = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].slice(1, -1);
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch { return undefined; }
}

export function codexModel(options: { model?: string; extraArgs?: string[] }): string | undefined {
  // CLI overrides win over config; profiles/local providers need runtime model
  // attestation and must not silently inherit the base config's model.
  let model = options.model;
  let overriddenConfig: string | undefined;
  let alternate = false;
  const args = options.extraArgs || [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-m" || arg === "--model") model = args[++i];
    else if (arg.startsWith("--model=")) model = arg.slice(8);
    else if (arg.startsWith("-m") && arg.length > 2) model = arg.slice(2);
    else if (arg.startsWith("-p") || arg.startsWith("--profile") || arg === "--oss" || arg === "--ignore-user-config" || arg.startsWith("--local-provider")) alternate = true;
    else if (arg === "-c" || arg === "--config" || arg.startsWith("--config=") || arg.startsWith("-c")) {
      const value = arg === "-c" || arg === "--config" ? args[++i] : arg.replace(/^(?:--config=|-c)/, "");
      if (/^model\s*=/.test(value || "")) overriddenConfig = value.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
      if (/^(?:profile|model_provider)\s*=/.test(value || "")) alternate = true;
    }
  }
  return model || overriddenConfig || (alternate ? undefined : configuredCodexModel());
}
