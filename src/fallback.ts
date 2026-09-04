/**
 * Auto-fallback to local Ollama when a cloud provider fails with an
 * auth / quota / rate-limit / 5xx error.
 *
 * Activated by default. Disable with SUPERAGENT_OLLAMA_FALLBACK=false.
 *
 * Rationale: RE-Orch-01 (192.168.1.100:11434) has 2× V100 32GB and a roster
 * of capable open models. When grok credits are exhausted, gemini quota is
 * hit, or deepseek 5xx's, falling back to local lets the user keep moving
 * instead of seeing a hard error and having to retry by hand.
 */
import { invokeOllama, OllamaInvocationError } from "./ollamaAgent.js";
import type { AgentInvocationResult } from "./types.js";

/**
 * Patterns that mark a cloud-provider error as fallback-eligible. Conservative
 * by design — we don't fall back on logical errors (bad prompt) or compile
 * errors, only on infrastructure failures the user can't fix in the moment.
 */
const FALLBACK_ELIGIBLE_PATTERNS: RegExp[] = [
  /credit/i,
  /quota/i,
  /rate.?limit/i,
  /unauthorized/i,
  /forbidden/i,
  /api.?key/i,
  /\b401\b/,
  /\b402\b/,
  /\b403\b/,
  /\b429\b/,
  /\b5\d{2}\b/,           // 5xx
  /\bunavailable\b/i,
  /\btimeout\b/i,
  /\binvalid_api/i,
  /credits? exhausted/i,
  /payment required/i,
  /insufficient_quota/i,
];

/**
 * Per-provider preferred ollama model. Picked to match the original
 * provider's strength as best the local roster allows.
 */
const PROVIDER_OLLAMA_MODEL: Record<string, string> = {
  codex: "qwen2.5-coder:32b-instruct-q4_K_M",      // code work
  gemini: "gemma2:27b-instruct-q4_K_M",            // general, fastest warm
  grok: "qwen3:30b-a3b",                           // general reasoning
  deepseek: "qwen3:30b-a3b",                       // general reasoning
  "deepseek-reasoner": "qwen2.5:72b",              // max reasoning
};

export function isFallbackEligible(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return FALLBACK_ELIGIBLE_PATTERNS.some((p) => p.test(msg));
}

export function fallbackEnabled(): boolean {
  return process.env.SUPERAGENT_OLLAMA_FALLBACK !== "false";
}

export function pickFallbackModel(provider: string, originalModel?: string): string {
  if (originalModel === "deepseek-reasoner") return PROVIDER_OLLAMA_MODEL["deepseek-reasoner"];
  return PROVIDER_OLLAMA_MODEL[provider] ?? "qwen3:30b-a3b";
}

export interface FallbackInput {
  prompt: string;
  agentSystemPrompt?: string;
  originalProvider: string;
  originalModel?: string;
  originalError: string;
  agent?: string;
  timeoutMs?: number;
}

/**
 * Try ollama as a fallback. Returns null if not eligible / disabled / ollama
 * also fails. On success returns an AgentInvocationResult flagged with
 * `tool: "ollama"` and a fallback note prepended to the response so the
 * caller can see the substitution happened.
 */
export async function tryOllamaFallback(input: FallbackInput): Promise<AgentInvocationResult | null> {
  if (!fallbackEnabled()) return null;
  if (!isFallbackEligible(input.originalError)) return null;

  const fallbackModel = pickFallbackModel(input.originalProvider, input.originalModel);

  try {
    const r = await invokeOllama({
      prompt: input.prompt,
      agentSystemPrompt: input.agentSystemPrompt,
      model: fallbackModel,
      timeoutMs: input.timeoutMs,
    });
    const note =
      `[ollama fallback from ${input.originalProvider}` +
      (input.originalModel ? `/${input.originalModel}` : "") +
      ` → ${fallbackModel} — reason: ${truncate(input.originalError, 120)}]`;
    return {
      status: "ok",
      agent: input.agent,
      prompt: input.prompt,
      tool: "ollama",
      response: `${note}\n\n${r.response}`,
      exitCode: 0,
      durationMs: r.durationMs,
    } as AgentInvocationResult;
  } catch (err) {
    if (err instanceof OllamaInvocationError) return null;
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
