import { spawn } from "node:child_process";
import { once } from "node:events";

export interface GeminiInvocationOptions {
  prompt: string;
  agentSystemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  workingDirectory?: string;
  includeRawEvents?: boolean;
}

export interface GeminiInvocationResponse {
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  response: string;
  stats?: any;
}

export class GeminiInvocationError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly exitCode: number;

  constructor(message: string, exitCode: number, stdout: string, stderr: string) {
    super(message);
    this.name = "GeminiInvocationError";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MIN_TIMEOUT_MS = 40000; // 40 seconds minimum to handle cold starts
const MAX_RETRIES = 2; // Retry up to 2 times on timeout
const RETRY_DELAY_MS = 2000; // 2 second delay between retries

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

function buildArgs(options: GeminiInvocationOptions): string[] {
  const args: string[] = [];

  // Build full prompt with proper hierarchy
  const fullPrompt = META_INSTRUCTION +
    (options.agentSystemPrompt ? options.agentSystemPrompt + "\n\nUser request:\n" : "") +
    options.prompt;
  args.push(fullPrompt);

  // Add output format for structured response
  args.push("--output-format", "json");

  // Add YOLO mode for automatic approval of all actions
  args.push("-y");  // or "--yolo"

  // Model selection: gemini-2.5-flash (default), gemini-2.5-flash-lite (worker/min),
  // gemini-2.5-pro (planner/max, quota-limited). gemini CLI 0.18.4.
  //
  // 2026-08-11 observed: gemini-2.5-flash executed a real shell command correctly, then
  // hit "You have exhausted your daily quota on this model" ~7 minutes later. Treat
  // Gemini as BEST-EFFORT — always have a fallback provider for anything load-bearing.
  //
  // Also observed: the CLI warns "Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using
  // GOOGLE_API_KEY." Unset one so the credential in use is unambiguous.
  //
  // CAUTION: this agent runs with -y (YOLO) and auto-approves every action, and unlike
  // grok/codex it returns no tool-call trace, so its actions cannot be audited after the
  // fact. Do not give it tasks that can mutate production.
  const model = options.model || "gemini-2.5-flash";
  args.push("-m", model);

  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseGeminiResponse(stdout: string): { response: string; stats?: any } {
  // Try to parse the entire stdout as JSON first (for multi-line JSON)
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.response !== undefined) {
      return {
        response: parsed.response || "",
        stats: parsed.stats
      };
    }
  } catch (e) {
    // Not a valid JSON, try line by line
  }

  // Find JSON block that might span multiple lines
  const jsonStart = stdout.indexOf('{');
  const jsonEnd = stdout.lastIndexOf('}');

  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    try {
      const jsonStr = stdout.substring(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonStr);
      if (parsed.response !== undefined) {
        return {
          response: parsed.response || "",
          stats: parsed.stats
        };
      }
    } catch (e) {
      // Continue to fallback
    }
  }

  // Fallback: return the entire stdout if no JSON found
  return {
    response: stdout.trim()
  };
}

async function invokeGeminiOnce(options: GeminiInvocationOptions, effectiveTimeoutMs: number): Promise<GeminiInvocationResponse> {
  const args = buildArgs(options);
  const start = Date.now();

  // Use full path to gemini CLI to ensure it's found regardless of PATH
  const geminiPath = process.env.GEMINI_PATH || "/usr/local/bin/gemini";
  const child = spawn(geminiPath, args, {
    cwd: options.workingDirectory ?? process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  // Gemini doesn't use stdin for prompts
  child.stdin.end();

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new GeminiInvocationError(
        `Gemini invocation timed out after ${effectiveTimeoutMs}ms`,
        -1,
        Buffer.concat(stdoutChunks).toString("utf8"),
        Buffer.concat(stderrChunks).toString("utf8")
      ));
    }, effectiveTimeoutMs);
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

  const exitCode = closeResult[0] ?? 0;

  if (exitCode !== 0) {
    throw new GeminiInvocationError(
      `Gemini exited with code ${exitCode}`,
      exitCode,
      stdout,
      stderr
    );
  }

  const parsed = parseGeminiResponse(stdout);

  return {
    exitCode,
    durationMs,
    stdout,
    stderr,
    response: parsed.response,
    stats: parsed.stats
  };
}

export async function invokeGemini(options: GeminiInvocationOptions): Promise<GeminiInvocationResponse> {
  // Ensure minimum timeout to handle cold starts
  const requestedTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const effectiveTimeoutMs = Math.max(requestedTimeout, MIN_TIMEOUT_MS);

  let lastError: GeminiInvocationError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await invokeGeminiOnce(options, effectiveTimeoutMs);
    } catch (error) {
      if (error instanceof GeminiInvocationError && error.message.includes("timed out")) {
        lastError = error;

        // Don't retry if we've exhausted retries
        if (attempt < MAX_RETRIES) {
          // Wait before retrying (exponential backoff: 2s, 4s)
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
      }
      // Non-timeout errors are thrown immediately
      throw error;
    }
  }

  // If we get here, all retries failed
  throw new GeminiInvocationError(
    `Gemini invocation failed after ${MAX_RETRIES + 1} attempts (last error: ${lastError?.message})`,
    lastError?.exitCode ?? -1,
    lastError?.stdout ?? "",
    lastError?.stderr ?? ""
  );
}