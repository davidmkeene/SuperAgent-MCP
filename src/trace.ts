import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Full provider traces (raw stdout event stream + stderr) are written here
 * instead of being returned to the caller.
 *
 *   Directory: $SUPERAGENT_TRACE_DIR, default ~/.cache/superagent-mcp/traces
 *   Retention: files older than $SUPERAGENT_TRACE_RETENTION_DAYS (default 7)
 *              are deleted, and at most $SUPERAGENT_TRACE_MAX_FILES (default
 *              500) newest files are kept. Pruning runs on every write.
 *   Mode:      directory 0700, files 0600 (traces can hold command output).
 */
export function traceDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SUPERAGENT_TRACE_DIR || join(homedir(), ".cache", "superagent-mcp", "traces");
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function retentionNote(env: NodeJS.ProcessEnv = process.env): string {
  return `traces kept ${num(env.SUPERAGENT_TRACE_RETENTION_DAYS, 7)} days, newest ${num(env.SUPERAGENT_TRACE_MAX_FILES, 500)} files max`;
}

function prune(dir: string, env: NodeJS.ProcessEnv): void {
  const maxAgeMs = num(env.SUPERAGENT_TRACE_RETENTION_DAYS, 7) * 24 * 3600 * 1000;
  const maxFiles = num(env.SUPERAGENT_TRACE_MAX_FILES, 500);
  const now = Date.now();
  const files = readdirSync(dir)
    .map((name) => {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        return st.isFile() ? { path, mtime: st.mtimeMs } : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((f): f is { path: string; mtime: number } => !!f)
    .sort((a, b) => b.mtime - a.mtime);
  files.forEach((f, i) => {
    if (i >= maxFiles || now - f.mtime > maxAgeMs) {
      try { unlinkSync(f.path); } catch { /* concurrent prune */ }
    }
  });
}

export interface TraceParts {
  meta: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

/** Write a trace file; returns its path, or undefined if it could not be written. */
export function writeTrace(provider: string, parts: TraceParts, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const dir = traceDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${provider}-${stamp}-${randomBytes(3).toString("hex")}.log`);
    const body =
      `# superagent ${provider} trace ${JSON.stringify(parts.meta)}\n` +
      `# ---- stdout (${parts.stdout.length} chars) ----\n${parts.stdout}` +
      `${parts.stdout.endsWith("\n") || !parts.stdout ? "" : "\n"}` +
      `# ---- stderr (${parts.stderr.length} chars) ----\n${parts.stderr}`;
    writeFileSync(path, body, { mode: 0o600 });
    try { prune(dir, env); } catch { /* pruning is best effort */ }
    return path;
  } catch {
    return undefined;
  }
}

export function tail(text: string, n = 2000): string {
  return text.length > n ? text.slice(text.length - n) : text;
}
