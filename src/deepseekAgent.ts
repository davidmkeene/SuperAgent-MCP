/**
 * DeepSeek Agent - Cloud LLM inference via DeepSeek API (OpenAI-compatible)
 *
 * Uses the DeepSeek API at https://api.deepseek.com with OpenAI-compatible
 * chat completions format. Requires DEEPSEEK_API_KEY environment variable.
 *
 * Available models:
 * Models — live list from GET https://api.deepseek.com/models, verified 2026-08-11:
 * - deepseek-v4-pro    Current flagship. Chain-of-thought. USE THIS.
 * - deepseek-v4-flash  Current fast/cheap tier.
 *
 * Legacy names deepseek-chat (V3) and deepseek-reasoner (R1) are NO LONGER in the
 * published model list. deepseek-chat still routes, but see the warning below.
 *
 * CRITICAL — NO TOOL LAYER. This agent is a plain chat-completions API call. Unlike the
 * codex/gemini/grok CLI agents it CANNOT execute shell commands, read files, or verify
 * anything. Never assign it audit, verification, or "go check X" work.
 *
 * Behaviour verified 2026-08-11 by asking each model to run a real git command whose
 * output was known:
 *   deepseek-chat    FABRICATED a realistic fake result ("fatal: not a git repository")
 *                    for a directory that IS a git repo. Dangerous — invented output
 *                    that looks authentic.
 *   deepseek-v4-pro  Correctly answered CANNOT_EXECUTE. Honest about its limits.
 * => Prefer deepseek-v4-pro, and only for reasoning over text supplied in the prompt.
 */

export interface DeepSeekInvocationOptions {
  prompt: string;
  agentSystemPrompt?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface DeepSeekInvocationResponse {
  durationMs: number;
  response: string;
  model: string;
  reasoningContent?: string;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export class DeepSeekInvocationError extends Error {
  public readonly statusCode?: number;
  public readonly response?: string;

  constructor(message: string, statusCode?: number, response?: string) {
    super(message);
    this.name = "DeepSeekInvocationError";
    this.statusCode = statusCode;
    this.response = response;
  }
}

const DEFAULT_API_BASE = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (reasoning model can be slow)

const META_INSTRUCTION = `You are an MCP-invoked agent. Your responses should be:
- Concise but complete
- Focus on the requested task
- Do what has been asked, nothing more, nothing less

You are a general-purpose agent capable of:
- Code analysis and review
- Documentation tasks
- Multi-step reasoning
- Problem solving and research

`;

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      reasoning_content?: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

export async function invokeDeepSeek(options: DeepSeekInvocationOptions): Promise<DeepSeekInvocationResponse> {
  const apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new DeepSeekInvocationError(
      "DEEPSEEK_API_KEY environment variable is not set. Get your API key from https://platform.deepseek.com",
      undefined,
      undefined
    );
  }

  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  // Build messages array
  const messages: ChatCompletionMessage[] = [];

  // System message with meta instruction + optional agent prompt
  const systemContent = META_INSTRUCTION +
    (options.agentSystemPrompt ? options.agentSystemPrompt : "");
  messages.push({ role: "system", content: systemContent });

  // User message
  messages.push({ role: "user", content: options.prompt });

  const start = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${DEFAULT_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new DeepSeekInvocationError(
        `DeepSeek API returned ${response.status}: ${errorText}`,
        response.status,
        errorText
      );
    }

    const data = await response.json() as ChatCompletionResponse;
    const durationMs = Date.now() - start;

    const choice = data.choices?.[0];
    if (!choice) {
      throw new DeepSeekInvocationError(
        "DeepSeek API returned empty response (no choices)",
        undefined,
        JSON.stringify(data)
      );
    }

    return {
      durationMs,
      response: choice.message.content,
      model: data.model,
      reasoningContent: choice.message.reasoning_content,
      tokens: data.usage ? {
        prompt: data.usage.prompt_tokens,
        completion: data.usage.completion_tokens,
        total: data.usage.total_tokens
      } : undefined
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof DeepSeekInvocationError) {
      throw error;
    }

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        throw new DeepSeekInvocationError(
          `DeepSeek invocation timed out after ${timeoutMs}ms`,
          undefined,
          undefined
        );
      }
      throw new DeepSeekInvocationError(
        `DeepSeek request failed: ${error.message}`,
        undefined,
        undefined
      );
    }

    throw new DeepSeekInvocationError(
      `DeepSeek request failed: ${String(error)}`,
      undefined,
      undefined
    );
  }
}
