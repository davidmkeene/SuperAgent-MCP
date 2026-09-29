import * as nodeFsForTrace from "node:fs";
import * as nodePathForTrace from "node:path";
import * as nodeOsForTrace from "node:os";
import { BatchInvokeInput, AgentInvocationResult, AgentPromptInput } from "./types.js";
import { invokeCodex, CodexInvocationError } from "./codexAgent.js";
import { invokeGemini, GeminiInvocationError } from "./geminiAgent.js";
import { invokeContinue, ContinueInvocationError } from "./continueAgent.js";
import { getAgent } from "./agentLoader.js";
import { z } from "zod";

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
// turn). NEVER return more than MAX_RESPONSE_CHARS inline -- the final
// message plus a path, not the trace.
const MAX_RESPONSE_CHARS = 8000;
const TRACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A real per-user cache directory (~/.cache/superagent/traces), not a
// worker-round-robin tmpdir path that can be cleared by the OS at any time
// -- overridable for tests/operators via SUPERAGENT_TRACE_DIR.
const TRACE_DIR = process.env.SUPERAGENT_TRACE_DIR
  || nodePathForTrace.join(nodeOsForTrace.homedir(), ".cache", "superagent", "traces");

/**
 * Delete trace files older than TRACE_MAX_AGE_MS. Call once at server
 * start-up (src/server.ts's main()) -- traces are write-once debugging
 * artifacts, not a log a caller ever needs to keep past a week, and nothing
 * else on this host rotates them.
 */
export function cleanupOldTraces(now: number = Date.now(), dir: string = TRACE_DIR): void {
  let entries: string[];
  try {
    entries = nodeFsForTrace.readdirSync(dir);
  } catch {
    return; // directory does not exist yet -- nothing to clean up
  }
  for (const name of entries) {
    const full = nodePathForTrace.join(dir, name);
    try {
      const stat = nodeFsForTrace.statSync(full);
      if (stat.isFile() && now - stat.mtimeMs > TRACE_MAX_AGE_MS) {
        nodeFsForTrace.unlinkSync(full);
      }
    } catch {
      // Best-effort: one unreadable/racing file must not stop the sweep.
    }
  }
}

export function persistTraceAndCapResponse(
  toolName: string, assistantReply: string, fullStdout: string, traceDir: string = TRACE_DIR
): string {
  const base = (assistantReply && assistantReply.trim())
    || "(codex produced no parsed final message; see the full trace file)";
  // doc-914 (round 2 review, item 9): a trace file is only worth writing
  // when the raw trace would not have fit inline anyway -- a short reply
  // from a short trace needs no on-disk artifact, and every call used to
  // write one regardless of size.
  if (fullStdout.length <= MAX_RESPONSE_CHARS && base.length <= MAX_RESPONSE_CHARS) {
    return base;
  }
  let tracePath: string | undefined;
  try {
    nodeFsForTrace.mkdirSync(traceDir, { recursive: true });
    tracePath = nodePathForTrace.join(
      traceDir,
      `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
    nodeFsForTrace.writeFileSync(tracePath, fullStdout, "utf8");
  } catch {
    // Trace persistence is best-effort: a disk/permission failure here must
    // never turn into "return the trace inline instead", or the original
    // bug comes right back under the one condition (no disk) it's worst.
    tracePath = undefined;
  }
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
    try {
      // Load agent system prompt if specified
      let agentSystemPrompt: string | undefined;
      if (prompt.agent) {
        const agent = getAgent(prompt.agent);
        if (agent) {
          agentSystemPrompt = agent.systemPrompt;
        }
      }

      const result = await invokeCodex({
        prompt: prompt.prompt,
        agentSystemPrompt,
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
        error: error instanceof Error ? error.message : String(error)
      } satisfies AgentInvocationResult;
    }
  });
}

// Function for Gemini batch processing
export async function runGeminiBatch(input: BaseInvokeInput): Promise<AgentInvocationResult[]> {
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

      const result = await invokeGemini({
        prompt: prompt.prompt,
        agentSystemPrompt,
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