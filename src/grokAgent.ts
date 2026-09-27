import { spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { grokModelUsed, type ModelUsed } from "./modelDefaults.js";
import { writeTrace } from "./trace.js";
import { isModelRejection, modelRejectedMessage } from "./codexEvents.js";

export interface GrokInvocationOptions {
  prompt: string;
  agentSystemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  workingDirectory?: string;
  includeRawEvents?: boolean;
}

export interface GrokInvocationResponse {
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  response: string;
  model: ModelUsed;
  tracePath?: string;
}

export class GrokInvocationError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly exitCode: number;
  public model?: ModelUsed;
  public tracePath?: string;
  public durationMs?: number;
  public kind?: "model_rejected" | "timeout" | "failed";

  constructor(message: string, exitCode: number, stdout: string, stderr: string) {
    super(message);
    this.name = "GrokInvocationError";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const META_INSTRUCTION = `You are an MCP-invoked agent. Your responses should be:
- Concise but complete
- Focus on the requested task
- Do what has been asked, nothing more, nothing less

You are a general-purpose agent capable of:
- Code analysis and modification
- Documentation tasks
- Multi-step research
- System exploration

User request: `;

function buildArgs(options: GrokInvocationOptions): string[] {
  const args: string[] = [];

  // Build full prompt with proper hierarchy
  const fullPrompt = META_INSTRUCTION +
    (options.agentSystemPrompt ? options.agentSystemPrompt + "\n\nUser request:\n" : "") +
    options.prompt;

  // Use headless mode with prompt flag
  args.push("-p", fullPrompt);

  // Server default lives in src/modelDefaults.ts; explicit per-call models win.
  const model = grokModelUsed(options.model).id;
  if (model) args.push("-m", model);

  // Auto-approve mode (similar to Gemini's YOLO mode)
  // The Grok CLI uses interactive mode by default, -p puts it in headless mode
  // which doesn't require approval

  return args;
}

function parseGrokResponse(stdout: string, stderr: string): string {
  // Grok CLI outputs conversationally to stdout
  // Filter out any progress indicators or metadata

  const lines = stdout.split('\n');
  const responseLines: string[] = [];

  for (const line of lines) {
    // Skip empty lines at the start
    if (responseLines.length === 0 && line.trim() === '') {
      continue;
    }
    // Skip spinner/progress indicators (common patterns)
    if (line.includes('⠋') || line.includes('⠙') || line.includes('⠹') ||
        line.includes('⠸') || line.includes('⠼') || line.includes('⠴') ||
        line.includes('⠦') || line.includes('⠧') || line.includes('⠇') ||
        line.includes('⠏')) {
      continue;
    }
    // Skip ANSI escape sequences for cursor movement
    if (line.includes('\x1b[') && line.includes('K')) {
      continue;
    }
    responseLines.push(line);
  }

  // Join and clean up the response
  let response = responseLines.join('\n').trim();

  // If stdout is empty, check stderr for any useful output
  if (!response && stderr) {
    response = stderr.trim();
  }

  return response;
}

export async function invokeGrok(options: GrokInvocationOptions): Promise<GrokInvocationResponse> {
  const args = buildArgs(options);
  const start = Date.now();

  // Native Grok Build with the existing grok.com subscription login.
  const grokPath = process.env.GROK_PATH || join(homedir(), ".grok", "bin", "grok");
  const grokEnv = { ...process.env };
  // API keys take precedence over OAuth; never inherit them into this lane.
  delete grokEnv.XAI_API_KEY;
  delete grokEnv.GROK_API_KEY;
  const child = spawn(grokPath, args, {
    cwd: options.workingDirectory ?? process.cwd(),
    env: grokEnv,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  // Grok CLI uses -p flag for prompt, doesn't use stdin
  child.stdin.end();

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new GrokInvocationError(
        `Grok invocation timed out after ${timeoutMs}ms`,
        -1,
        Buffer.concat(stdoutChunks).toString("utf8"),
        Buffer.concat(stderrChunks).toString("utf8")
      ));
    }, timeoutMs);
  });

  const model = grokModelUsed(options.model);
  const finish = (exitCode: number, timedOut: boolean) => {
    const durationMs = Date.now() - start;
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    const tracePath = writeTrace("grok", {
      meta: { exitCode, durationMs, model, cwd: options.workingDirectory ?? process.cwd(), timedOut },
      stdout,
      stderr
    });
    return { durationMs, stdout, stderr, tracePath };
  };

  let closeResult: [number | null, NodeJS.Signals | null];
  try {
    closeResult = (await Promise.race([once(child, "close"), timeoutPromise])) as [number | null, NodeJS.Signals | null];
  } catch (error) {
    if (error instanceof GrokInvocationError) {
      const f = finish(-1, true);
      Object.assign(error, { model, tracePath: f.tracePath, durationMs: f.durationMs, kind: "timeout" });
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  const exitCode = closeResult[0] ?? 0;
  const { durationMs, stdout, stderr, tracePath } = finish(exitCode, false);

  if (exitCode !== 0) {
    const errText = `${stderr.slice(-4000)}\n${stdout.slice(-2000)}`;
    const rejected = isModelRejection(undefined, errText);
    const lastLine = errText.trim().split("\n").filter((l) => /model/i.test(l)).pop() ?? "";
    const error = new GrokInvocationError(
      rejected ? modelRejectedMessage("Grok", model.id, undefined, lastLine) : `Grok exited with code ${exitCode}`,
      exitCode,
      stdout,
      stderr
    );
    Object.assign(error, { model, tracePath, durationMs, kind: rejected ? "model_rejected" : "failed" });
    throw error;
  }

  const response = parseGrokResponse(stdout, stderr);

  return {
    exitCode,
    durationMs,
    stdout,
    stderr,
    response,
    model,
    tracePath
  };
}
