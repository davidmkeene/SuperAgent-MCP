import * as nodeFsForTrace from "node:fs";
import * as nodePathForTrace from "node:path";
import * as nodeOsForTrace from "node:os";
import { BatchInvokeInput, AgentInvocationResult, AgentPromptInput, OllamaInvokeSchema, DeepSeekInvokeSchema } from "./types.js";
import { invokeCodex, CodexInvocationError } from "./codexAgent.js";
import { invokeGemini, GeminiInvocationError } from "./geminiAgent.js";
import { invokeContinue, ContinueInvocationError } from "./continueAgent.js";
import { invokeGrok, GrokInvocationError } from "./grokAgent.js";
import { invokeOllama, OllamaInvocationError } from "./ollamaAgent.js";
import { invokeDeepSeek, DeepSeekInvocationError } from "./deepseekAgent.js";
import { getAgent } from "./agentLoader.js";
import { tryOllamaFallback } from "./fallback.js";
import { z } from "zod";

import { MultiInvokeInput, ChainInvokeInput, MultiPromptInput, ChainStepInput } from "./types.js";
import { withRetry } from "./retry.js";
import { cacheKey, getCached, setCache } from "./cache.js";

// Type for the base schema without agentEnv
type BaseInvokeInput = z.infer<typeof import("./types.js").CodexInvokeSchema>;

// doc-914 #7 (round 2 independent review): a codex call used to return the
// ENTIRE raw stdout trace (72k-441k characters, seen 3x in one session)
// whenever the parsed assistantReply came back empty -- `result.assistantReply
// || result.stdout` fell all the way back to the raw trace, which blew past
// the MCP transport's own result-size limit and forced a caller to grep a
// manually-saved trace file instead. codexAgent.ts's parser fix (item.completed
// support) means assistantReply is now populated whenever codex actually said
// anything, so this fallback should rarely trigger for a real reply -- but it
// still must never dump the raw trace inline for the cases that remain (a
// turn that genuinely never emitted an agent_message, e.g. a bare tool-call
// turn). ALWAYS persist the full trace to disk, and NEVER return more than
// MAX_RESPONSE_CHARS inline -- the final message plus a path, not the trace.
const MAX_RESPONSE_CHARS = 8000;
const TRACE_DIR = process.env.SUPERAGENT_TRACE_DIR
  || nodePathForTrace.join(nodeOsForTrace.tmpdir(), "superagent-traces");

export function persistTraceAndCapResponse(
  toolName: string, assistantReply: string, fullStdout: string
): string {
  let tracePath: string | undefined;
  try {
    nodeFsForTrace.mkdirSync(TRACE_DIR, { recursive: true });
    tracePath = nodePathForTrace.join(
      TRACE_DIR,
      `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
    nodeFsForTrace.writeFileSync(tracePath, fullStdout, "utf8");
  } catch {
    // Trace persistence is best-effort: a disk/permission failure here must
    // never turn into "return the trace inline instead", or the original
    // bug comes right back under the one condition (no disk) it's worst.
    tracePath = undefined;
  }
  const base = (assistantReply && assistantReply.trim())
    || "(codex produced no parsed final message; see the full trace file)";
  const traceNote = tracePath
    ? ` [full trace: ${fullStdout.length} chars written to ${tracePath}]`
    : ` [full trace: ${fullStdout.length} chars, NOT persisted -- trace dir unwritable]`;
  const budget = Math.max(0, MAX_RESPONSE_CHARS - traceNote.length);
  const capped = base.length > budget
    ? base.slice(0, budget) + "... [truncated]"
    : base;
  return capped + traceNote;
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let activeCount = 0;

  return new Promise((resolve, reject) => {
    const launchNext = () => {
      if (nextIndex >= items.length && activeCount === 0) {
        resolve(results);
        return;
      }

      while (activeCount < limit && nextIndex < items.length) {
        const currentIndex = nextIndex++;
        activeCount += 1;

        worker(items[currentIndex], currentIndex)
          .then((value) => {
            results[currentIndex] = value;
          })
          .catch((error) => {
            reject(error);
          })
          .finally(() => {
            activeCount -= 1;
            launchNext();
          });
      }
    };

    launchNext();
  });
}

// Function for Codex batch processing
export async function runCodexBatch(input: BaseInvokeInput): Promise<AgentInvocationResult[]> {
  const concurrency = Math.min(input.concurrency ?? input.inputs.length, input.inputs.length);

  return runWithConcurrency(input.inputs, concurrency, async (prompt) => {
    // Load agent system prompt if specified — hoisted so the fallback
    // path in catch can also see it.
    let agentSystemPrompt: string | undefined;
    if (prompt.agent) {
      const agent = getAgent(prompt.agent);
      if (agent) {
        agentSystemPrompt = agent.systemPrompt;
      }
    }
    try {
      const result = await invokeCodex({
        prompt: prompt.prompt,
        agentSystemPrompt,
        model: prompt.model,
        extraArgs: prompt.extraArgs,
        timeoutMs: prompt.timeoutMs,
        workingDirectory: prompt.workingDirectory
      });
      return {
        status: "ok",
        agent: prompt.agent,
        prompt: prompt.prompt,
        tool: "codex",
        response: persistTraceAndCapResponse("codex", result.assistantReply, result.stdout),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        rawEvents: undefined,
        rawOutput: undefined,
        stderr: undefined
      } satisfies AgentInvocationResult;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const fb = await tryOllamaFallback({
        prompt: prompt.prompt,
        agentSystemPrompt,
        originalProvider: "codex",
        originalModel: prompt.model,
        originalError: errMsg,
        agent: prompt.agent,
        timeoutMs: prompt.timeoutMs,
      });
      if (fb) return fb;
      if (error instanceof CodexInvocationError) {
        return {
          status: "error",
          agent: prompt.agent,
          prompt: prompt.prompt,
          tool: "codex",
          error: error.message,
          exitCode: error.exitCode,
          rawOutput: error.stdout,
          stderr: error.stderr
        } satisfies AgentInvocationResult;
      }

      return {
        status: "error",
        agent: prompt.agent,
        prompt: prompt.prompt,
        tool: "codex",
        error: errMsg
      } satisfies AgentInvocationResult;
    }
  });
}

// Function for Gemini batch processing
export async function runGeminiBatch(input: BaseInvokeInput): Promise<AgentInvocationResult[]> {
  const concurrency = Math.min(input.concurrency ?? input.inputs.length, input.inputs.length);

  return runWithConcurrency(input.inputs, concurrency, async (prompt) => {
    let agentSystemPrompt: string | undefined;
    if (prompt.agent) {
      const agent = getAgent(prompt.agent);
      if (agent) {
        agentSystemPrompt = agent.systemPrompt;
      }
    }
    try {
      const result = await invokeGemini({
        prompt: prompt.prompt,
        agentSystemPrompt,
        model: prompt.model,
        timeoutMs: prompt.timeoutMs,
        workingDirectory: prompt.workingDirectory
      });
      return {
        status: "ok",
        agent: prompt.agent,
        prompt: prompt.prompt,
        tool: "gemini",
        response: result.response,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        rawEvents: undefined,
        rawOutput: undefined,
        stderr: undefined
      } satisfies AgentInvocationResult;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const fb = await tryOllamaFallback({
        prompt: prompt.prompt,
        agentSystemPrompt,
        originalProvider: "gemini",
        originalModel: prompt.model,
        originalError: errMsg,
        agent: prompt.agent,
        timeoutMs: prompt.timeoutMs,
      });
      if (fb) return fb;
      if (error instanceof GeminiInvocationError) {
        return {
          status: "error",
          agent: prompt.agent,
          prompt: prompt.prompt,
          tool: "gemini",
          error: error.message,
          exitCode: error.exitCode,
          rawOutput: error.stdout,
          stderr: error.stderr
        } satisfies AgentInvocationResult;
      }

      return {
        status: "error",
        agent: prompt.agent,
        prompt: prompt.prompt,
        tool: "gemini",
        error: errMsg
      } satisfies AgentInvocationResult;
    }
  });
}

// Function for Grok batch processing
export async function runGrokBatch(input: BaseInvokeInput): Promise<AgentInvocationResult[]> {
  const concurrency = Math.min(input.concurrency ?? input.inputs.length, input.inputs.length);

  return runWithConcurrency(input.inputs, concurrency, async (prompt) => {
    let agentSystemPrompt: string | undefined;
    if (prompt.agent) {
      const agent = getAgent(prompt.agent);
      if (agent) {
        agentSystemPrompt = agent.systemPrompt;
      }
    }
    try {
      const result = await invokeGrok({
        prompt: prompt.prompt,
        agentSystemPrompt,
        model: prompt.model,
        timeoutMs: prompt.timeoutMs,
        workingDirectory: prompt.workingDirectory
      });
      return {
        status: "ok",
        agent: prompt.agent,
        prompt: prompt.prompt,
        tool: "grok",
        response: result.response,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        rawEvents: undefined,
        rawOutput: undefined,
        stderr: undefined
      } satisfies AgentInvocationResult;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const fb = await tryOllamaFallback({
        prompt: prompt.prompt,
        agentSystemPrompt,
        originalProvider: "grok",
        originalModel: prompt.model,
        originalError: errMsg,
        agent: prompt.agent,
        timeoutMs: prompt.timeoutMs,
      });
      if (fb) return fb;
      if (error instanceof GrokInvocationError) {
        return {
          status: "error",
          agent: prompt.agent,
          prompt: prompt.prompt,
          tool: "grok",
          error: error.message,
          exitCode: error.exitCode,
          rawOutput: error.stdout,
          stderr: error.stderr
        } satisfies AgentInvocationResult;
      }

      return {
        status: "error",
        agent: prompt.agent,
        prompt: prompt.prompt,
        tool: "grok",
        error: errMsg
      } satisfies AgentInvocationResult;
    }
  });
}

// Type for DeepSeek schema
type DeepSeekInvokeInput = z.infer<typeof DeepSeekInvokeSchema>;

// Function for DeepSeek batch processing
export async function runDeepSeekBatch(input: DeepSeekInvokeInput): Promise<AgentInvocationResult[]> {
  const concurrency = Math.min(input.concurrency ?? 1, input.inputs.length);

  return runWithConcurrency(input.inputs, concurrency, async (prompt) => {
    try {
      const result = await invokeDeepSeek({
        prompt: prompt.prompt,
        model: prompt.model,
        apiKey: prompt.apiKey,
        timeoutMs: prompt.timeoutMs
      });

      let response = result.response;
      // For reasoner model, include reasoning content if present
      if (result.reasoningContent) {
        response = `<reasoning>\n${result.reasoningContent}\n</reasoning>\n\n${response}`;
      }

      return {
        status: "ok",
        agent: prompt.model || "deepseek-chat",
        prompt: prompt.prompt,
        tool: "deepseek",
        response,
        exitCode: 0,
        durationMs: result.durationMs,
        rawEvents: undefined,
        rawOutput: undefined,
        stderr: undefined
      } satisfies AgentInvocationResult;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const fb = await tryOllamaFallback({
        prompt: prompt.prompt,
        originalProvider: "deepseek",
        originalModel: prompt.model,
        originalError: errMsg,
        agent: prompt.model || "deepseek-chat",
        timeoutMs: prompt.timeoutMs,
      });
      if (fb) return fb;
      if (error instanceof DeepSeekInvocationError) {
        return {
          status: "error",
          agent: prompt.model || "deepseek-chat",
          prompt: prompt.prompt,
          tool: "deepseek",
          error: error.message,
          exitCode: error.statusCode ?? -1,
          rawOutput: error.response,
          stderr: undefined
        } satisfies AgentInvocationResult;
      }

      return {
        status: "error",
        agent: prompt.model || "deepseek-chat",
        prompt: prompt.prompt,
        tool: "deepseek",
        error: errMsg
      } satisfies AgentInvocationResult;
    }
  });
}

// Type for Ollama schema
type OllamaInvokeInput = z.infer<typeof OllamaInvokeSchema>;

// Function for Ollama batch processing
export async function runOllamaBatch(input: OllamaInvokeInput): Promise<AgentInvocationResult[]> {
  const concurrency = Math.min(input.concurrency ?? 1, input.inputs.length);

  return runWithConcurrency(input.inputs, concurrency, async (prompt) => {
    try {
      const result = await invokeOllama({
        prompt: prompt.prompt,
        model: prompt.model,
        host: prompt.host,
        task: prompt.task,
        numCtx: prompt.numCtx,
        timeoutMs: prompt.timeoutMs
      });
      return {
        status: "ok",
        agent: result.model,
        prompt: prompt.prompt,
        tool: "ollama",
        response: result.response,
        exitCode: 0,
        durationMs: result.durationMs,
        rawEvents: undefined,
        rawOutput: undefined,
        stderr: undefined
      } satisfies AgentInvocationResult;
    } catch (error) {
      if (error instanceof OllamaInvocationError) {
        return {
          status: "error",
          agent: prompt.model || "qwen3:30b-a3b",
          prompt: prompt.prompt,
          tool: "ollama",
          error: error.message,
          exitCode: error.statusCode ?? -1,
          rawOutput: error.response,
          stderr: undefined
        } satisfies AgentInvocationResult;
      }

      return {
        status: "error",
        agent: prompt.model || "qwen3:30b-a3b",
        prompt: prompt.prompt,
        tool: "ollama",
        error: error instanceof Error ? error.message : String(error)
      } satisfies AgentInvocationResult;
    }
  });
}

// Function for Continue batch processing
export async function runContinueBatch(input: BaseInvokeInput): Promise<AgentInvocationResult[]> {
  const concurrency = Math.min(input.concurrency ?? input.inputs.length, input.inputs.length);

  return runWithConcurrency(input.inputs, concurrency, async (prompt) => {
    try {
      // Load agent system prompt if specified
      let agentSystemPrompt: string | undefined;
      if (prompt.agent) {
        const agent = getAgent(prompt.agent);
        if (agent) {
          agentSystemPrompt = agent.systemPrompt;
        }
      }

      const result = await invokeContinue({
        prompt: prompt.prompt,
        agentSystemPrompt,
        timeoutMs: prompt.timeoutMs,
        workingDirectory: prompt.workingDirectory
      });
      return {
        status: "ok",
        agent: prompt.agent,
        prompt: prompt.prompt,
        tool: "continue",
        response: result.response,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        rawEvents: undefined,
        rawOutput: undefined,
        stderr: undefined
      } satisfies AgentInvocationResult;
    } catch (error) {
      if (error instanceof ContinueInvocationError) {
        return {
          status: "error",
          agent: prompt.agent,
          prompt: prompt.prompt,
          tool: "continue",
          error: error.message,
          exitCode: error.exitCode,
          rawOutput: error.stdout,
          stderr: error.stderr
        } satisfies AgentInvocationResult;
      }

      return {
        status: "error",
        agent: prompt.agent,
        prompt: prompt.prompt,
        tool: "continue",
        error: error instanceof Error ? error.message : String(error)
      } satisfies AgentInvocationResult;
    }
  });
}

async function invokeSingleTask(task: MultiPromptInput): Promise<AgentInvocationResult> {
  const { provider, prompt, agent, model, workingDirectory, extraArgs, timeoutMs } = task;

  // Check cache first
  if (task.cache) {
    const key = cacheKey(provider, prompt, model);
    const cached = getCached(key);
    if (cached) {
      return { ...cached, durationMs: 0 } as AgentInvocationResult;
    }
  }

  // Load agent system prompt if specified
  let agentSystemPrompt: string | undefined;
  if (agent) {
    const agentDef = getAgent(agent);
    if (agentDef) {
      agentSystemPrompt = agentDef.systemPrompt;
    }
  }

  try {
    let response: string = "";
    let exitCode = 0;
    let durationMs = 0;

    const result = await withRetry(async () => {
      switch (provider) {
        case "codex": {
          const r = await invokeCodex({ prompt, agentSystemPrompt, model, extraArgs, timeoutMs, workingDirectory });
          return { response: r.assistantReply || r.stdout, exitCode: r.exitCode, durationMs: r.durationMs };
        }
        case "gemini": {
          const r = await invokeGemini({ prompt, agentSystemPrompt, model, timeoutMs, workingDirectory });
          return { response: r.response, exitCode: r.exitCode, durationMs: r.durationMs };
        }
        case "grok": {
          const r = await invokeGrok({ prompt, agentSystemPrompt, model, timeoutMs, workingDirectory });
          return { response: r.response, exitCode: r.exitCode, durationMs: r.durationMs };
        }
        case "deepseek": {
          const r = await invokeDeepSeek({ prompt, agentSystemPrompt, model, timeoutMs });
          let resp = r.response;
          if (r.reasoningContent) {
            resp = `<reasoning>\n${r.reasoningContent}\n</reasoning>\n\n${resp}`;
          }
          return { response: resp, exitCode: 0, durationMs: r.durationMs };
        }
        case "ollama": {
          const r = await invokeOllama({ prompt, model, timeoutMs });
          return { response: r.response, exitCode: 0, durationMs: r.durationMs };
        }
        default:
          throw new Error(`Unknown provider: ${provider}`);
      }
    });

    response = result.response;
    exitCode = result.exitCode;
    durationMs = result.durationMs;

    const invocationResult: AgentInvocationResult = {
      status: "ok",
      agent: agent || `${provider}/${model || "default"}`,
      prompt,
      tool: provider,
      response,
      exitCode,
      durationMs,
      rawEvents: undefined,
      rawOutput: undefined,
      stderr: undefined
    };

    // Cache the result if requested
    if (task.cache) {
      const key = cacheKey(provider, prompt, model);
      setCache(key, invocationResult);
    }

    return invocationResult;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (provider !== "ollama") {
      const fb = await tryOllamaFallback({
        prompt,
        agentSystemPrompt,
        originalProvider: provider,
        originalModel: model,
        originalError: errMsg,
        agent,
        timeoutMs,
      });
      if (fb) return fb;
    }
    return {
      status: "error",
      agent: agent || `${provider}/${model || "default"}`,
      prompt,
      tool: provider,
      error: errMsg
    } as AgentInvocationResult;
  }
}

export async function runMultiBatch(input: MultiInvokeInput): Promise<AgentInvocationResult[]> {
  const concurrency = Math.min(input.concurrency ?? 4, input.inputs.length);
  return runWithConcurrency(input.inputs, concurrency, async (task) => {
    return invokeSingleTask(task);
  });
}

export async function runChain(input: ChainInvokeInput): Promise<AgentInvocationResult[]> {
  const results: AgentInvocationResult[] = [];
  let prevOutput = "";

  for (const step of input.steps) {
    // Substitute {{prev}} with previous step's output
    const resolvedPrompt = step.prompt.replace(/\{\{prev\}\}/g, prevOutput);

    const task: MultiPromptInput = {
      provider: step.provider,
      prompt: resolvedPrompt,
      agent: step.agent,
      model: step.model,
      workingDirectory: step.workingDirectory,
      extraArgs: step.extraArgs,
      timeoutMs: step.timeoutMs,
      cache: false
    };

    const result = await invokeSingleTask(task);
    results.push(result);

    if (result.status === "ok" && 'response' in result) {
      prevOutput = result.response;
    } else {
      prevOutput = "";
      if (input.stopOnError) {
        break;
      }
    }
  }

  return results;
}

// Keep backward compatibility function
function resolveAgent(prompt: AgentPromptInput, agentEnv: string) {
  if (agentEnv === "gemini") {
    return {
      agentName: "gemini",
      run: () =>
        invokeGemini({
          prompt: prompt.prompt,
          timeoutMs: prompt.timeoutMs,
          workingDirectory: prompt.workingDirectory
        })
    };
  } else if (agentEnv === "codex") {
    return {
      agentName: "codex",
      run: () =>
        invokeCodex({
          prompt: prompt.prompt,
          extraArgs: prompt.extraArgs,
          timeoutMs: prompt.timeoutMs,
          workingDirectory: prompt.workingDirectory
        })
    };
  } else {
    throw new Error(`Unsupported agent environment: ${agentEnv}`);
  }
}

// Keep backward compatibility with original runBatch
export async function runBatch(input: BatchInvokeInput): Promise<AgentInvocationResult[]> {
  const concurrency = Math.min(input.concurrency ?? input.prompts.length, input.prompts.length);

  return runWithConcurrency(input.prompts, concurrency, async (prompt) => {
    const agent = resolveAgent(prompt, input.agentEnv);

    try {
      const result = await agent.run() as any;  // Type workaround for different response types
      // Handle different response types. `result.response` covers gemini/
      // continue (never large enough to need trace-capping observed so
      // far); the codex path has no `.response` field at all, only
      // assistantReply/stdout -- doc-914 #7 (round 2 review): this is
      // runner.ts's SECOND fallback site with the exact same bug as
      // runCodexBatch's (`result.assistantReply || result.stdout`, without
      // ever capping the raw trace), reached via the legacy resolveAgent/
      // runBatch path rather than runCodexBatch.
      const response = result.response !== undefined
        ? result.response
        : persistTraceAndCapResponse(agent.agentName, result.assistantReply, result.stdout);
      const rawEvents = input.includeRawEvents ?
                       (result.stats || result.parsedEvents) : undefined;

      return {
        status: "ok",
        agent: prompt.agent,
        prompt: prompt.prompt,
        tool: agent.agentName as "codex" | "gemini",
        response: response,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        rawEvents: rawEvents,
        rawOutput: input.includeRawEvents ? result.stdout : undefined,
        stderr: input.includeRawEvents ? result.stderr : undefined
      } satisfies AgentInvocationResult;
    } catch (error) {
      const isCodexError = error instanceof CodexInvocationError;
      const isGeminiError = error instanceof GeminiInvocationError;

      if (isCodexError || isGeminiError) {
        const invocationError = error as CodexInvocationError | GeminiInvocationError;
        return {
          status: "error",
          agent: prompt.agent,
          prompt: prompt.prompt,
          tool: agent.agentName as "codex" | "gemini",
          error: invocationError.message,
          exitCode: invocationError.exitCode,
          rawOutput: invocationError.stdout,
          stderr: invocationError.stderr
        } satisfies AgentInvocationResult;
      }

      return {
        status: "error",
        agent: prompt.agent,
        prompt: prompt.prompt,
        tool: agent.agentName as "codex" | "gemini",
        error: error instanceof Error ? error.message : String(error)
      } satisfies AgentInvocationResult;
    }
  });
}
