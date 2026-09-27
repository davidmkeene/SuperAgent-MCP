import { spawn } from "node:child_process";
import { once } from "node:events";
import { registerProcess } from "./processManager.js";
import { summarizeCodexStream, isModelRejection, modelRejectedMessage, type CodexSummary } from "./codexEvents.js";
import { codexModelUsed, type ModelUsed } from "./modelDefaults.js";
import { writeTrace } from "./trace.js";

export interface CodexInvocationOptions {
  prompt: string;
  agentSystemPrompt?: string;
  model?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  workingDirectory?: string;
  includeRawEvents?: boolean;
}

export interface CodexInvocationEvent {
  [key: string]: unknown;
}

export interface CodexInvocationResponse {
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  parsedEvents: CodexInvocationEvent[];
  /** Final agent message (last agent_message item). Empty if none was emitted. */
  assistantReply: string;
  summary: CodexSummary;
  model: ModelUsed;
  tracePath?: string;
}

export class CodexInvocationError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly exitCode: number;
  public summary?: CodexSummary;
  public model?: ModelUsed;
  public tracePath?: string;
  public durationMs?: number;
  /** "model_rejected" when the provider refused the model id. */
  public kind?: "model_rejected" | "timeout" | "failed";

  constructor(message: string, exitCode: number, stdout: string, stderr: string) {
    super(message);
    this.name = "CodexInvocationError";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function buildArgs(options: CodexInvocationOptions): string[] {
  const args: string[] = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox"  // Full permissions - no restrictions
  ];

  // Model: pass -m only when the caller supplies one (the operator named it).
  // Unset => Codex uses its own configured default ($CODEX_HOME/config.toml).
  // Do not add a recommended/default model here; see src/modelDefaults.ts.
  if (options.model) {
    args.push("-m", options.model);
  }

  if (options.extraArgs && options.extraArgs.length > 0) {
    args.push(...options.extraArgs);
  }

  args.push("-");
  return args;
}

function parseJsonLines(stdout: string): CodexInvocationEvent[] {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const events: CodexInvocationEvent[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      events.push(parsed);
    } catch {
      events.push({ type: "log", data: line });
    }
  }

  return events;
}

const META_INSTRUCTION = `You are an MCP-invoked agent. Your responses should be:
- Concise but complete
- Focus on the requested task
- Do what has been asked, nothing more, nothing less

You are a general-purpose agent capable of:
- Code analysis and modification
- Documentation tasks
- Multi-step research
- System exploration

User request:
`;

export async function invokeCodex(options: CodexInvocationOptions): Promise<CodexInvocationResponse> {
  const args = buildArgs(options);
  const start = Date.now();

  // Use full path to codex CLI to ensure it's found regardless of PATH
  const codexPath = process.env.CODEX_PATH || "/usr/local/bin/codex";
  const child = spawn(codexPath, args, {
    cwd: options.workingDirectory ?? process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  // Register process for cleanup on shutdown
  registerProcess(child);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  // Build full prompt with proper hierarchy
  const fullPrompt = META_INSTRUCTION +
    (options.agentSystemPrompt ? options.agentSystemPrompt + "\n\nUser request:\n" : "") +
    options.prompt;
  child.stdin.write(fullPrompt);
  child.stdin.end();

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CodexInvocationError(`Codex invocation timed out after ${timeoutMs}ms`, -1, Buffer.concat(stdoutChunks).toString("utf8"), Buffer.concat(stderrChunks).toString("utf8")));
    }, timeoutMs);
  });

  const finish = (exitCode: number, timedOut: boolean) => {
    const durationMs = Date.now() - start;
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    const summary = summarizeCodexStream(stdout);
    const model = codexModelUsed(options.model, options.extraArgs);
    const tracePath = writeTrace("codex", {
      meta: { exitCode, durationMs, model, cwd: options.workingDirectory ?? process.cwd(), timedOut },
      stdout,
      stderr
    });
    return { durationMs, stdout, stderr, summary, model, tracePath };
  };

  let closeResult: [number | null, NodeJS.Signals | null];
  try {
    closeResult = (await Promise.race([once(child, "close"), timeoutPromise])) as [number | null, NodeJS.Signals | null];
  } catch (error) {
    if (error instanceof CodexInvocationError) {
      const f = finish(-1, true);
      Object.assign(error, { summary: f.summary, model: f.model, tracePath: f.tracePath, durationMs: f.durationMs, kind: "timeout" });
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  const exitCode = closeResult[0] ?? 0;
  const { durationMs, stdout, stderr, summary, model, tracePath } = finish(exitCode, false);

  if (exitCode !== 0 || summary.failed) {
    const rejected = isModelRejection(summary.lastError, summary.lastError ? "" : stderr.slice(-4000));
    const message = rejected
      ? modelRejectedMessage("Codex", model.id, summary.lastError, stderr.slice(-400))
      : summary.lastError
        ? `Codex exited with code ${exitCode}: ${summary.lastError.message.slice(0, 400)}`
        : `Codex exited with code ${exitCode}`;
    const error = new CodexInvocationError(message, exitCode, stdout, stderr);
    Object.assign(error, { summary, model, tracePath, durationMs, kind: rejected ? "model_rejected" : "failed" });
    throw error;
  }

  return {
    exitCode,
    durationMs,
    stdout,
    stderr,
    parsedEvents: parseJsonLines(stdout),
    assistantReply: summary.finalMessage,
    summary,
    model,
    tracePath
  };
}
