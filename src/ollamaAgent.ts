import { probeFleet, route, type TaskClass } from "./fleet.js";

/**
 * Ollama Agent - Local LLM inference via Ollama API
 *
 * This agent makes HTTP requests to the Ollama API running on RE-Orch-01 (192.168.1.100:11434).
 * Use for cost-effective local inference on SIMPLE tasks.
 *
 * Available models (pulled on 192.168.1.100):
 * - qwen3:30b-a3b (default) - High quality general-purpose
 * - qwen2.5:72b - Largest general model, best reasoning
 * - llama3.1:70b - Meta's flagship, strong general
 * - gemma2:27b-instruct-q4_K_M - Google's open model
 * - codestral:22b - Mistral code-specialized model
 * - deepseek-coder-v2:16b - Code-specialized, ideal for code review
 */

export interface OllamaInvocationOptions {
  prompt: string;
  agentSystemPrompt?: string;
  model?: string;
  host?: string;
  task?: TaskClass;
  numCtx?: number;
  keepAlive?: string | number;
  timeoutMs?: number;
  stream?: boolean;
}

export interface OllamaInvocationResponse {
  durationMs: number;
  response: string;
  model: string;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export class OllamaInvocationError extends Error {
  public readonly statusCode?: number;
  public readonly response?: string;

  constructor(message: string, statusCode?: number, response?: string) {
    super(message);
    this.name = "OllamaInvocationError";
    this.statusCode = statusCode;
    this.response = response;
  }
}

const DEFAULT_HOST = "http://192.168.1.100:11434";
const DEFAULT_MODEL = "qwen3:30b-a3b";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (local models are fast)
const DEFAULT_KEEP_ALIVE: string | number = "5m";

const META_INSTRUCTION = `You are a local AI assistant running on Ollama. Your responses should be:
- Concise and accurate
- Focus on the requested task
- Provide helpful information without unnecessary elaboration

`;

interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  done_reason?: string;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface OllamaPsResponse {
  models?: Array<{
    name: string;
    size?: number;
    expires_at?: string;
  }>;
}

export interface OllamaLoadedModel {
  name: string;
  size?: number;
  expires_at?: string;
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments?: unknown;
  };
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface OllamaChatOptions {
  messages: OllamaChatMessage[];
  tools?: OllamaTool[];
  model?: string;
  host?: string;
  task?: TaskClass;
  numCtx?: number;
  keepAlive?: string | number;
  timeoutMs?: number;
}

export interface OllamaChatResponse {
  durationMs: number;
  model: string;
  message?: OllamaChatMessage;
  toolCalls: OllamaToolCall[];
}

interface OllamaChatApiResponse {
  model: string;
  message?: OllamaChatMessage;
}

export async function invokeOllama(options: OllamaInvocationOptions): Promise<OllamaInvocationResponse> {
  if (!options.host && !options.model && options.task) await probeFleet();
  const routed = (!options.host && !options.model && options.task) ? route(options.task) : undefined;
  const host = options.host || routed?.host.endpoint || DEFAULT_HOST;
  const model = options.model || routed?.model || DEFAULT_MODEL;
  const keepAlive = options.keepAlive ?? DEFAULT_KEEP_ALIVE;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  // Build full prompt with system context
  const fullPrompt = META_INSTRUCTION +
    (options.agentSystemPrompt ? options.agentSystemPrompt + "\n\n" : "") +
    "User request: " + options.prompt;

  const start = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        prompt: fullPrompt,
        stream: false,
        keep_alive: keepAlive,
        options: { num_ctx: options.numCtx ?? 16384 }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new OllamaInvocationError(
        `Ollama API returned ${response.status}: ${errorText}`,
        response.status,
        errorText
      );
    }

    const data = await response.json() as OllamaGenerateResponse;
    const durationMs = Date.now() - start;

    return {
      durationMs,
      response: data.response,
      model: data.model,
      tokens: data.prompt_eval_count !== undefined ? {
        prompt: data.prompt_eval_count,
        completion: data.eval_count || 0,
        total: (data.prompt_eval_count || 0) + (data.eval_count || 0)
      } : undefined
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof OllamaInvocationError) {
      throw error;
    }

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        throw new OllamaInvocationError(
          `Ollama invocation timed out after ${timeoutMs}ms`,
          undefined,
          undefined
        );
      }
      throw new OllamaInvocationError(
        `Ollama request failed: ${error.message}`,
        undefined,
        undefined
      );
    }

    throw new OllamaInvocationError(
      `Ollama request failed: ${String(error)}`,
      undefined,
      undefined
    );
  }
}

export async function unloadModel(endpoint: string, model: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        prompt: "",
        keep_alive: 0,
        stream: false
      })
    });

    return response.ok;
  } catch {
    return false;
  }
}

export async function loadedModels(endpoint: string): Promise<OllamaLoadedModel[]> {
  try {
    const response = await fetch(`${endpoint}/api/ps`);
    if (!response.ok) {
      return [];
    }
    const data = await response.json() as OllamaPsResponse;
    return (data.models || []).map(model => ({
      name: model.name,
      size: model.size,
      expires_at: model.expires_at
    }));
  } catch {
    return [];
  }
}

export async function unloadAll(endpoint: string): Promise<string[]> {
  const models = await loadedModels(endpoint);
  const unloaded: string[] = [];

  for (const model of models) {
    const ok = await unloadModel(endpoint, model.name);
    if (ok) {
      unloaded.push(model.name);
    }
  }

  return unloaded;
}

export async function runOllamaChat(options: OllamaChatOptions): Promise<OllamaChatResponse> {
  if (!options.host && !options.model && options.task) await probeFleet();
  const routed = (!options.host && !options.model && options.task) ? route(options.task) : undefined;
  const host = options.host || routed?.host.endpoint || DEFAULT_HOST;
  const model = options.model || routed?.model || DEFAULT_MODEL;
  const keepAlive = options.keepAlive ?? DEFAULT_KEEP_ALIVE;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: options.messages,
        tools: options.tools,
        stream: false,
        keep_alive: keepAlive,
        options: { num_ctx: options.numCtx ?? 16384 }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new OllamaInvocationError(
        `Ollama chat API returned ${response.status}: ${errorText}`,
        response.status,
        errorText
      );
    }

    const data = await response.json() as OllamaChatApiResponse;

    return {
      durationMs: Date.now() - start,
      model: data.model,
      message: data.message,
      toolCalls: data.message?.tool_calls || []
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof OllamaInvocationError) {
      throw error;
    }

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        throw new OllamaInvocationError(
          `Ollama chat timed out after ${timeoutMs}ms`,
          undefined,
          undefined
        );
      }
      throw new OllamaInvocationError(
        `Ollama chat request failed: ${error.message}`,
        undefined,
        undefined
      );
    }

    throw new OllamaInvocationError(
      `Ollama chat request failed: ${String(error)}`,
      undefined,
      undefined
    );
  }
}

/**
 * List available models from Ollama
 */
export async function listOllamaModels(host?: string): Promise<string[]> {
  const ollamaHost = host || DEFAULT_HOST;

  try {
    const response = await fetch(`${ollamaHost}/api/tags`);
    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }
    const data = await response.json() as { models: Array<{ name: string }> };
    return data.models.map(m => m.name);
  } catch {
    return [];
  }
}
