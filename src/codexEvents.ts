/**
 * Summarise a `codex exec --json` event stream.
 *
 * Current Codex (0.4x .. 0.157 observed) emits thread.started, turn.started,
 * item.started / item.updated / item.completed (item.type agent_message,
 * reasoning, command_execution, file_change, mcp_tool_call, web_search, error,
 * ...), turn.completed {usage}, and on failure error {message} and
 * turn.failed {error:{message}}. The legacy `{msg:{type:"agent_message"}}`
 * shape is still read for older CLIs.
 */

export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
}

export interface ProviderError {
  type: string;
  status?: number;
  message: string;
}

export interface CodexSummary {
  finalMessage: string;
  usage: CodexUsage | null;
  filesChanged: { path: string; kind?: string }[];
  commands: { count: number; nonzero_exit: { command: string; exit_code: number }[] };
  lastError?: ProviderError;
  failed: boolean;
}

const USAGE_KEYS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"] as const;

function parseLines(stdout: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object") out.push(v);
    } catch { /* non-JSON log line */ }
  }
  return out;
}

/**
 * Provider errors arrive as a JSON string inside `message`, e.g.
 * {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"..."}}.
 * Unwrap to the human-readable part.
 */
export function unwrapProviderError(message: string): ProviderError {
  let msg = message;
  let status: number | undefined;
  let type = "error";
  for (let depth = 0; depth < 3; depth++) {
    const trimmed = msg.trim();
    const start = trimmed.indexOf("{");
    if (start < 0) break;
    let parsed: any;
    try { parsed = JSON.parse(trimmed.slice(start)); } catch { break; }
    if (typeof parsed?.status === "number") status = parsed.status;
    const inner = parsed?.error ?? parsed;
    if (typeof inner?.type === "string") type = inner.type;
    const next = typeof inner === "string" ? inner : inner?.message ?? parsed?.detail ?? parsed?.message;
    if (typeof next !== "string" || next === msg) break;
    const prefix = trimmed.slice(0, start).trim();
    if (status === undefined) {
      const m = prefix.match(/\b([45]\d\d)\b/);
      if (m) status = Number(m[1]);
    }
    msg = next;
  }
  if (status === undefined) {
    const m = msg.match(/\bstatus[:= ]+([45]\d\d)\b|\b([45]\d\d) (Bad Request|Not Found)\b/i);
    if (m) status = Number(m[1] ?? m[2]);
  }
  return status === undefined ? { type, message: msg } : { type, status, message: msg };
}

export function summarizeCodexStream(stdout: string): CodexSummary {
  const events = parseLines(stdout);
  const agentMessages: string[] = [];
  const legacyReplies: string[] = [];
  const files = new Map<string, string | undefined>();
  let commandCount = 0;
  const nonzero: { command: string; exit_code: number }[] = [];
  let usage: CodexUsage | null = null;
  let lastError: ProviderError | undefined;
  let failed = false;

  for (const ev of events) {
    const type = ev.type;
    const item = ev.item;
    if (type === "item.completed" && item && typeof item === "object") {
      if (item.type === "agent_message" && typeof item.text === "string") agentMessages.push(item.text);
      if (item.type === "command_execution") {
        commandCount++;
        if (typeof item.exit_code === "number" && item.exit_code !== 0) {
          nonzero.push({ command: String(item.command ?? "").slice(0, 100), exit_code: item.exit_code });
        }
      }
      if (item.type === "file_change" && Array.isArray(item.changes)) {
        for (const c of item.changes) if (c && typeof c.path === "string") files.set(c.path, c.kind);
      }
    } else if (type === "turn.completed" && ev.usage && typeof ev.usage === "object") {
      const acc: Record<string, number> = (usage as Record<string, number> | null) ?? { input_tokens: 0, output_tokens: 0 };
      for (const k of USAGE_KEYS) if (typeof ev.usage[k] === "number") acc[k] = (acc[k] ?? 0) + ev.usage[k];
      usage = acc as unknown as CodexUsage;
    } else if (type === "turn.failed") {
      failed = true;
      const m = ev.error?.message;
      if (typeof m === "string") lastError = unwrapProviderError(m);
    } else if (type === "error" && typeof ev.message === "string") {
      lastError = unwrapProviderError(ev.message);
    } else if (ev.msg && typeof ev.msg === "object") {
      collectLegacy(ev.msg, legacyReplies);
    } else if (type === "message" && ev.data?.role === "assistant" && Array.isArray(ev.data.content)) {
      for (const c of ev.data.content) if (typeof c?.text === "string" && c.text) legacyReplies.push(c.text);
    }
  }

  const finalMessage = (agentMessages.length ? agentMessages[agentMessages.length - 1] : legacyReplies.join("\n")).trim();
  return {
    finalMessage,
    usage,
    filesChanged: [...files].map(([path, kind]) => (kind ? { path, kind } : { path })),
    commands: { count: commandCount, nonzero_exit: nonzero.slice(-5) },
    lastError,
    failed
  };
}

function collectLegacy(msg: Record<string, any>, replies: string[]): void {
  if (msg.type === "agent_message" && typeof msg.message === "string" && msg.message.trim()) replies.push(msg.message.trim());
  if ((msg.type === "agent_message" || msg.type === "assistant_message") && Array.isArray(msg.content)) {
    for (const c of msg.content) if (typeof c?.text === "string" && c.text.trim()) replies.push(c.text.trim());
  }
}

/**
 * True when a provider error says the requested/configured model is not
 * accepted. Pattern-based on the provider's own wording; no model deny list.
 */
export function isModelRejection(err: ProviderError | undefined, text = ""): boolean {
  const msg = `${err?.message ?? ""}\n${text}`;
  if (!/\bmodel\b/i.test(msg)) return false;
  // Codex prints "Model metadata for `x` not found. Defaulting to fallback
  // metadata" as a non-fatal warning; ignore it.
  const cleaned = msg.replace(/Model metadata for [^\n]*?Defaulting to fallback metadata[^\n]*/gi, "");
  if (!/\bmodel\b/i.test(cleaned)) return false;
  return (err?.status !== undefined && [400, 404].includes(err.status) && /\bmodel\b/i.test(err.message)) ||
    /model[^\n]{0,120}\b(not supported|unsupported|not found|does not exist|not available|unknown|invalid)\b/i.test(cleaned) ||
    /\b(unknown|invalid|unsupported) model\b/i.test(cleaned);
}

export function modelRejectedMessage(provider: string, model: string | null, err: ProviderError | undefined, fallbackDetail = ""): string {
  const name = model ? `'${model}'` : "(its configured default model)";
  const status = err?.status ? ` (HTTP ${err.status})` : "";
  const detail = (err?.message || fallbackDetail).trim().replace(/\s+/g, " ").slice(0, 400);
  return `${provider} rejected model ${name}${status}: ${detail} ` +
    `Fix: omit model to use the provider default; pass a model only if the operator has named one.`;
}
