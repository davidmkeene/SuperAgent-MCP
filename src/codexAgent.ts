import { spawn } from "node:child_process";
import { once } from "node:events";
import { registerProcess } from "./processManager.js";

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
  assistantReply: string;
}

export class CodexInvocationError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly exitCode: number;

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

  // Model selection. Verified 2026-08-11 against codex-cli 0.147.0 by running a real
  // shell command and checking the returned output against a known value:
  //   gpt-5.3-codex     WORKS — executes shell, exit_code reported, ~3s. Use this.
  //   o4-mini           DO NOT USE. Fails: emits "Model metadata not found", then loops
  //                     ~12 empty web_search calls, burns ~20k tokens, and finally
  //                     answers CANNOT_EXECUTE without ever running the command.
  //   o3 / gpt-5-codex-mini  UNVERIFIED here — test before relying on them.
  // NOTE: codex-cli prints "Model metadata for <id> not found. Defaulting to fallback
  // metadata" for ids missing from its internal table. On gpt-5.3-codex this is benign
  // (execution still works); it is NOT a signal the model is unusable.
  if (options.model) {
    args.push("-m", options.model);
  }

  if (options.extraArgs && options.extraArgs.length > 0) {
    args.push(...options.extraArgs);
  }

  args.push("-");
  return args;
}

function collectFromMsg(msg: Record<string, unknown>, replies: string[]): void {
  const type = msg["type"];

  if (type === "agent_message") {
    const message = msg["message"];
    if (typeof message === "string" && message.trim().length > 0) {
      replies.push(message.trim());
    }

    const content = msg["content"];
    if (Array.isArray(content)) {
      for (const chunk of content) {
        if (chunk && typeof chunk === "object" && "text" in chunk) {
          const text = (chunk as { text?: unknown }).text;
          if (typeof text === "string" && text.trim().length > 0) {
            replies.push(text.trim());
          }
        }
      }
    }
  }

  if (type === "assistant_message") {
    const content = msg["content"];
    if (Array.isArray(content)) {
      for (const chunk of content) {
        if (chunk && typeof chunk === "object" && "text" in chunk) {
          const text = (chunk as { text?: unknown }).text;
          if (typeof text === "string" && text.trim().length > 0) {
            replies.push(text.trim());
          }
        }
      }
    }
  }
}

export function parseAssistantReply(events: CodexInvocationEvent[]): string {
  const replies: string[] = [];
  // doc-914 #7 (round 2 independent review): codex-cli 0.157.0 emits
  // `{"type":"item.completed","item":{"type":"agent_message","text":...}}`
  // instead of the legacy `{msg:{type:"agent_message", message: ...}}`
  // shape below -- the parser never recognised it at all, so
  // `assistantReply` was ALWAYS empty against a current CLI, and every
  // caller fell back to `result.stdout`: the FULL raw trace (72k-441k
  // characters, three times in one session per doc 914), which blew past
  // the MCP transport's own result-size limit. A turn can emit several
  // item.completed agent_message events (progress notes, then a final
  // summary) -- keep only the LAST one: "the final message", per doc 914's
  // own fix request ("return only the final message from the lane"), not a
  // concatenation of everything said along the way.
  let lastItemMessage: string | undefined;

  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }

    if (event["type"] === "item.completed") {
      const item = event["item"];
      if (item && typeof item === "object") {
        const itemObj = item as Record<string, unknown>;
        if (itemObj["type"] === "agent_message" && typeof itemObj["text"] === "string") {
          const text = (itemObj["text"] as string).trim();
          if (text.length > 0) {
            lastItemMessage = text;
          }
        }
      }
      continue;
    }

    if ("msg" in event && event.msg && typeof event.msg === "object") {
      collectFromMsg(event.msg as Record<string, unknown>, replies);
      continue;
    }

    if (event["type"] === "message") {
      const data = event["data"] as Record<string, unknown> | undefined;
      if (!data || data["role"] !== "assistant") {
        continue;
      }

      const content = data["content"];
      if (Array.isArray(content)) {
        for (const chunk of content) {
          if (chunk && typeof chunk === "object" && "text" in chunk) {
            const text = (chunk as { text?: unknown }).text;
            if (typeof text === "string" && text.length > 0) {
              replies.push(text);
            }
          }
        }
      }
    }
  }

  // The modern shape wins when present: it is what any current codex-cli
  // actually emits. The legacy join is the fallback for an older CLI whose
  // events never had `item.completed` at all.
  if (lastItemMessage !== undefined) {
    return lastItemMessage;
  }
  return replies.join("\n").trim();
}

export function parseJsonLines(stdout: string): CodexInvocationEvent[] {
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
    throw new CodexInvocationError(
      `Codex exited with code ${exitCode}`,
      exitCode,
      stdout,
      stderr
    );
  }

  const events = parseJsonLines(stdout);
  const assistantReply = parseAssistantReply(events);

  return {
    exitCode,
    durationMs,
    stdout,
    stderr,
    parsedEvents: events,
    assistantReply
  };
}
