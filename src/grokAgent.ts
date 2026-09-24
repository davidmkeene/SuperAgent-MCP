import { spawn } from "node:child_process";
import { once } from "node:events";
import { accountCli } from "./accounting.js";

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
}

export class GrokInvocationError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly exitCode: number;

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
  args.push("-p", fullPrompt, "--output-format", "json");

  // Model selection. Verified 2026-08-11 against `grok models` (grok CLI 0.1.220):
  //   grok-build-latest              CLI default, self-updating alias — prefer this for build/coding
  //   grok-4.5                       NEWEST reasoning model
  //   grok-4.3                       previous reasoning flagship
  //   grok-4.20-0309-reasoning       / -non-reasoning
  //   grok-4.20-multi-agent-0309     multi-agent
  //   grok-build-0.1                 pinned build agent (grok-build-latest supersedes)
  // NOT in the live list (do not use): grok-4-latest, grok-code-fast-1, grok-3-mini,
  // grok-4-1-fast-latest. These were carried here as "still routing" aliases but xAI
  // no longer advertises them; re-check with `grok models` before reinstating.
  if (options.model) {
    args.push("-m", options.model);
  }

  // Auto-approve mode (similar to Gemini's YOLO mode)
  // The Grok CLI uses interactive mode by default, -p puts it in headless mode
  // which doesn't require approval

  return args;
}

function parseGrokResponse(stdout: string, stderr: string): string {
  // Keep machine-readable accounting out of the user-visible response.
  try {
    const result = JSON.parse(stdout);
    if (typeof result.text === "string") return result.text;
    if (typeof result.result === "string") return result.result;
    if (typeof result.response === "string") return result.response;
    if (Array.isArray(result.content)) {
      return result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    }
  } catch { /* Preserve the legacy text path for older CLIs. */ }
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
  return accountCli("grok", options.model, () => invokeGrokOnce(options));
}

async function invokeGrokOnce(options: GrokInvocationOptions): Promise<GrokInvocationResponse> {
  const args = buildArgs(options);
  const start = Date.now();

  // Use full path to grok CLI wrapper to ensure it's found regardless of PATH
  // Falls back to system grok if wrapper not found
  const grokPath = process.env.GROK_PATH || "/usr/local/bin/grok";
  const child = spawn(grokPath, args, {
    cwd: options.workingDirectory ?? process.cwd(),
    env: process.env,
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

  let closeResult: [number | null, NodeJS.Signals | null];
  try {
    closeResult = (await Promise.race([once(child, "close"), timeoutPromise])) as [number | null, NodeJS.Signals | null];
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  const durationMs = Date.now() - start;
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  const exitCode = closeResult[0] ?? -1;

  if (exitCode !== 0) {
    throw new GrokInvocationError(
      `Grok exited with code ${exitCode}`,
      exitCode,
      stdout,
      stderr
    );
  }

  const response = parseGrokResponse(stdout, stderr);

  return {
    exitCode,
    durationMs,
    stdout,
    stderr,
    response
  };
}
