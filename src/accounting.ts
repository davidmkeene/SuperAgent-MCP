import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CliProvider, parseUsage } from "./usage.js";

export interface CostReceipt {
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  delivery: "pending" | "captured" | "posted" | "failed";
}
interface Context {
  receipts: CostReceipt[];
  attribution: Record<string, string>;
  send?: (payload: Record<string, unknown>) => Promise<void>;
}
const context = new AsyncLocalStorage<Context>();
const providerNames = { codex: "openai", grok: "xai", gemini: "google" };

export function receiptMetadata(receipts: CostReceipt[]) {
  // The legacy provider-run-accounting hook recursively harvests any object
  // containing input_tokens, even inside _meta, and would post a SECOND cost
  // under a different request ID. Keep the replayable payload opaque to that
  // heuristic; the server already owns delivery. No usage enters reply text.
  return receipts.map(({ payload, ...receipt }) => ({ ...receipt,
    payload_encoding: "base64-json", payload_base64: Buffer.from(JSON.stringify(payload)).toString("base64") }));
}

export async function collectCostReceipts<T>(fn: () => Promise<T>, attribution: Record<string, string> = {},
  send?: Context["send"]): Promise<{ result: T; receipts: CostReceipt[] }> {
  const state: Context = { receipts: [], attribution, send };
  const result = await context.run(state, fn);
  return { result, receipts: state.receipts };
}

export function buildReceipts(provider: CliProvider, model: string | undefined, stdout: string, stderr: string,
  path: string, requestId = `superagent-${provider}-${randomUUID()}`, attribution: Record<string, string> = {}): CostReceipt[] {
  return parseUsage(provider, stdout, stderr).map((parsed, index) => {
    const actualModel = parsed.model || model;
    const usage = actualModel ? parsed : { ...parsed, usage_known: false,
      reason: `${provider}/${path}/model: runtime model could not be resolved` };
    const alias = `${provider}-default`;
    const metadata = { model_alias: alias, ...(provider === "codex" ? { legacy_model_aliases: [alias, "codex-cli-default"] } : {}),
      usage_source: parsed.source, invocation_path: `${provider}/${path}`,
      ...(usage.reason ? { usage_unknown_reason: `${provider}/${path}: ${usage.reason}` } : {}),
      ...(usage.observed_total_tokens !== undefined ? { observed_total_tokens: usage.observed_total_tokens } : {}) };
    // report_cost has no metadata/reason argument. Its request_id is persisted
    // in operation_metadata, so retain alias and reason there as well as in the
    // MCP receipt envelope. Never send unsupported arguments that get dropped.
    const identity = `${requestId}:${index}:alias=${alias}` +
      (usage.reason ? `:reason=${encodeURIComponent(String(metadata.usage_unknown_reason))}` : "");
    return { payload: { provider: providerNames[provider], model: actualModel || "unknown",
      agent_id: "superagent", ...attribution, request_id: identity,
      usage_input: usage.input_tokens, usage_output: usage.output_tokens,
      input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens, usage_known: usage.usage_known },
      metadata, delivery: "pending" };
  });
}

function costAcknowledged(value: any): boolean {
  if (!value || value.error || value.isError || value.success === false) return false;
  if (value.success === true && value.cost_event_id) return true;
  if (value.result) return costAcknowledged(value.result);
  if (value.structuredContent) return costAcknowledged(value.structuredContent);
  return Array.isArray(value.content) && value.content.some((c: any) => {
    try { return c.type === "text" && costAcknowledged(JSON.parse(c.text)); } catch { return false; }
  });
}

export async function postCost(payload: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<void> {
  // Explicit operator configuration avoids guessing credentials or another
  // session's attribution. Tests inject a sender; capture mode never reads
  // connection settings and never makes a network request.
  const configPath = process.env.SUPERAGENT_REO_MCP_CONFIG;
  if (!configPath) throw new Error("SUPERAGENT_REO_MCP_CONFIG is not configured");
  const config = JSON.parse(readFileSync(configPath, "utf8")).mcpServers?.["orchestrator-rag"];
  if (!config?.url) throw new Error("orchestrator-rag HTTP connection is missing");
  const response = await fetcher(config.url.replace(/\/$/, "") + "/", {
    method: "POST", signal: AbortSignal.timeout(8000),
    headers: { ...config.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: payload.request_id, method: "tools/call",
      params: { name: "report_cost", arguments: payload } })
  });
  if (!response.ok) throw new Error(`report_cost HTTP ${response.status}`);
  const text = await response.text();
  const documents = text.trim().startsWith("{") ? [text] :
    text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
  if (!documents.some(doc => { try { return costAcknowledged(JSON.parse(doc)); } catch { return false; } })) {
    throw new Error("report_cost did not acknowledge a cost_event_id");
  }
}

export async function accountCli<T extends { stdout: string; stderr: string }>(provider: CliProvider,
  model: string | undefined, run: () => Promise<T>): Promise<T> {
  let output: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
  let path = "success";
  try {
    const result = await run();
    output = result;
    return result;
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    output = { stdout: e.stdout || "", stderr: e.stderr || "" };
    path = e.message?.includes("timed out") ? "timeout" : e.stdout !== undefined ? "nonzero-exit" : "spawn-error";
    throw error;
  } finally {
    const state = context.getStore();
    const receipts = buildReceipts(provider, model, output.stdout, output.stderr, path, undefined, state?.attribution);
    for (const receipt of receipts) {
      state?.receipts.push(receipt);
      if (!receipt.payload.usage_known) console.error(`[superagent] WARNING: USAGE UNKNOWN: ${receipt.metadata.usage_unknown_reason}`);
      if (process.env.SUPERAGENT_COST_MODE === "capture") {
        receipt.delivery = "captured";
      } else {
        try {
          await (state?.send || postCost)(receipt.payload);
          receipt.delivery = "posted";
        } catch {
          // Do not print connection config, credentials, or arbitrary server errors.
          receipt.delivery = "failed";
          console.error(`[superagent] WARNING: COST RECEIPT NOT POSTED: ${receipt.payload.request_id}; inspect MCP _meta["reo/cost_receipts"] and REO connection configuration`);
        }
      }
    }
  }
}
