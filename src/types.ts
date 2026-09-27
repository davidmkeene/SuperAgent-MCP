import { z } from "zod";

export const AgentIdentifierSchema = z.string().min(1).max(64);

export const AgentPromptSchema = z.object({
  agent: z.string().optional().describe("Name of specialized agent to use (e.g., 'backend-architect', 'python-expert')"),
  prompt: z.string().min(1, "prompt must not be empty").describe("The prompt to send to the agent"),
  model: z.string().optional().describe("Optional provider model ID. Grok defaults to grok-4.7 (operator selection, 2026-09-21); other CLI providers use their configured default when omitted. Explicit model IDs override these defaults and must be supported by the configured provider."),
  extraArgs: z.array(z.string()).optional().describe("Additional CLI arguments (Codex only)"),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional().describe("Timeout in milliseconds (default: 30 min, max: 60 min)"),
  workingDirectory: z.string().optional().describe("Directory path where agent should run. Use this to access different projects")
});

// Schema without agentEnv - base schema for both tools
const BaseInvokeSchema = z.object({
  inputs: z.array(AgentPromptSchema).min(1, "provide at least one input").describe("Array of inputs to execute"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(1)
    .describe("Number of inputs to run in parallel (1-16, default: 1)")
});

// Keep original for backward compatibility
export const BatchInvokeSchema = z.object({
  prompts: z.array(AgentPromptSchema).min(1, "provide at least one prompt"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(2),
  agentEnv: z.enum(["codex", "gemini"]).default("codex"),
  includeRawEvents: z.boolean().default(false)
});

// DeepSeek-specific prompt schema
export const DeepSeekPromptSchema = z.object({
  prompt: z.string().min(1, "prompt must not be empty").describe("The prompt to send to DeepSeek"),
  model: z.string().optional().describe("DeepSeek model to use (default: deepseek-chat). Options: deepseek-chat (V3, fast/cheap), deepseek-reasoner (R1, chain-of-thought reasoning)"),
  apiKey: z.string().optional().describe("DeepSeek API key (default: DEEPSEEK_API_KEY env var)"),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional().describe("Timeout in milliseconds (default: 10 min, max: 60 min)")
});

// Ollama-specific prompt schema with model/host options
export const OllamaPromptSchema = z.object({
  prompt: z.string().min(1, "prompt must not be empty").describe("The prompt to send to Ollama"),
  task: z.enum(["embed", "classify", "summarize", "draft", "code-review", "reason", "agentic"])
    .default("draft")
    .describe("Task class used by the live fleet router when host and model are not pinned"),
  model: z.string().optional().describe("Optional Ollama model override; omit with host to use fleet routing"),
  host: z.string().optional().describe("Ollama API host (default: http://192.168.1.100:11434)"),
  numCtx: z.number().int().min(2048).max(131072).default(16384)
    .describe("Ollama context window; defaults to 16384 to prevent host-RAM spill"),
  timeoutMs: z.number().int().positive().max(10 * 60 * 1000).optional().describe("Timeout in milliseconds (default: 5 min, max: 10 min)")
});

// Specific schemas for each tool
export const CodexInvokeSchema = BaseInvokeSchema;
export const GeminiInvokeSchema = BaseInvokeSchema;
export const ContinueInvokeSchema = BaseInvokeSchema;
export const GrokInvokeSchema = BaseInvokeSchema;
export const DeepSeekInvokeSchema = z.object({
  inputs: z.array(DeepSeekPromptSchema).min(1, "provide at least one input").describe("Array of inputs to execute"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(1)
    .describe("Number of inputs to run in parallel (1-16, default: 1)")
});
export const OllamaInvokeSchema = z.object({
  inputs: z.array(OllamaPromptSchema).min(1, "provide at least one input").describe("Array of inputs to execute"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe("Number of inputs to run in parallel (1-4, default: 1, limited for local GPU)")
});

// === Multi-provider parallel execution ===

export const MultiPromptSchema = z.object({
  provider: z.enum(["codex", "gemini", "grok", "deepseek", "ollama"]).describe("Which provider to use for this task"),
  prompt: z.string().min(1).describe("The prompt to send"),
  agent: z.string().optional().describe("Specialized agent name (e.g., 'backend-architect', 'security-engineer')"),
  model: z.string().optional().describe("Model override for this task"),
  workingDirectory: z.string().optional().describe("Working directory for CLI agents (codex/gemini/grok)"),
  extraArgs: z.array(z.string()).optional().describe("Extra CLI args (Codex only)"),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional().describe("Per-task timeout in ms"),
  cache: z.boolean().optional().default(false).describe("Cache this result to avoid re-execution of identical prompts")
});

export const MultiInvokeSchema = z.object({
  inputs: z.array(MultiPromptSchema).min(1).describe("Array of tasks — each specifies its own provider, model, and prompt. All run in parallel."),
  concurrency: z.number().int().min(1).max(16).default(4).describe("Max parallel tasks across all providers (default: 4)")
});

// === Sequential chain execution ===

export const ChainStepSchema = z.object({
  provider: z.enum(["codex", "gemini", "grok", "deepseek", "ollama"]).describe("Provider for this step"),
  prompt: z.string().min(1).describe("Prompt template. Use {{prev}} to inject the previous step's output."),
  agent: z.string().optional().describe("Specialized agent name"),
  model: z.string().optional().describe("Model override"),
  workingDirectory: z.string().optional().describe("Working directory for CLI agents"),
  extraArgs: z.array(z.string()).optional().describe("Extra CLI args (Codex only)"),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional().describe("Per-step timeout in ms")
});

export const ChainInvokeSchema = z.object({
  steps: z.array(ChainStepSchema).min(1).max(10).describe("Sequential steps. Each step can use {{prev}} to reference the prior step's output."),
  stopOnError: z.boolean().default(true).describe("Stop the chain if any step fails (default: true)")
});

export type MultiPromptInput = z.infer<typeof MultiPromptSchema>;
export type MultiInvokeInput = z.infer<typeof MultiInvokeSchema>;
export type ChainStepInput = z.infer<typeof ChainStepSchema>;
export type ChainInvokeInput = z.infer<typeof ChainInvokeSchema>;

export type AgentPromptInput = z.infer<typeof AgentPromptSchema>;
export type BatchInvokeInput = z.infer<typeof BatchInvokeSchema>;

export interface AgentInvocationSuccess {
  status: "ok";
  agent?: string;
  prompt: string;
  tool: string;
  response: string;
  exitCode: number;
  durationMs: number;
  rawEvents?: unknown[];
  rawOutput?: string;
  stderr?: string;
}

export interface AgentInvocationErrorResult {
  status: "error";
  agent?: string;
  prompt: string;
  tool: string;
  error: string;
  exitCode?: number;
  rawOutput?: string;
  stderr?: string;
}

export type AgentInvocationResult = AgentInvocationSuccess | AgentInvocationErrorResult;
