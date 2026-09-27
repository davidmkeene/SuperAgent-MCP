#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  TextContent
} from "@modelcontextprotocol/sdk/types.js";
import { CodexInvokeSchema, GeminiInvokeSchema, ContinueInvokeSchema, GrokInvokeSchema, DeepSeekInvokeSchema, OllamaInvokeSchema, MultiInvokeSchema, ChainInvokeSchema } from "./types.js";
import { runCodexBatch, runGeminiBatch, runContinueBatch, runGrokBatch, runDeepSeekBatch, runOllamaBatch, runMultiBatch, runChain } from "./runner.js";
import { formatAgentsForDescription, ensureAgentsDirectory, loadAgents } from "./agentLoader.js";
import { setupSignalHandlers } from "./processManager.js";
import { AgentInvocationResult } from "./types.js";
import { GROK_DEFAULT_MODEL } from "./modelDefaults.js";
import { traceDir, retentionNote } from "./trace.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

// Color codes for tasks (1-16)
const TASK_COLORS = [
  '\x1b[34m', // 1: Blue
  '\x1b[32m', // 2: Green
  '\x1b[33m', // 3: Yellow
  '\x1b[35m', // 4: Magenta
  '\x1b[36m', // 5: Cyan
  '\x1b[31m', // 6: Red
  '\x1b[94m', // 7: Bright Blue
  '\x1b[92m', // 8: Bright Green
  '\x1b[93m', // 9: Bright Yellow
  '\x1b[95m', // 10: Bright Magenta
  '\x1b[96m', // 11: Bright Cyan
  '\x1b[91m', // 12: Bright Red
  '\x1b[90m', // 13: Bright Black (Gray)
  '\x1b[37m', // 14: White
  '\x1b[97m', // 15: Bright White
  '\x1b[39m'  // 16: Default
];
const RESET_COLOR = '\x1b[0m';

const CODEX_TOOL = "codex";
const GEMINI_TOOL = "gemini";
const CONTINUE_TOOL = "continue";
const GROK_TOOL = "grok";
const DEEPSEEK_TOOL = "deepseek";
const OLLAMA_TOOL = "ollama";
const MULTI_TOOL = "multi";
const CHAIN_TOOL = "chain";

// Dynamically create tool definitions with available agents
const LIST_AGENTS_TOOL = "list-agents";

function createToolDefinitions(): { codex: Tool, gemini: Tool, continue: Tool, grok: Tool, deepseek: Tool, ollama: Tool, multi: Tool, chain: Tool, listAgents: Tool } {
  const agentsList = formatAgentsForDescription();

  return {
    codex: {
      name: CODEX_TOOL,
      description: "Run Codex CLI agent with parallel execution. Codex has REAL shell access; every command it runs is recorded in the event trace, so its work is auditable. Use 'workingDirectory' to target a project. Model: leave `model` unset to use the provider default (Codex's own configured model); pass a model only if the operator has named one. A model the provider rejects returns an error naming that model. Result (JSON): final agent message, token usage (input, cached, output, reasoning), exit code, duration, the model actually used, files changed, commands run, and trace_path, a file holding the full event stream. Set trace: \"full\" on an input to also get the raw stream inline (often 100-300 KB).",
      inputSchema: zodToJsonSchema(CodexInvokeSchema) as Tool["inputSchema"]
    },
    gemini: {
      name: GEMINI_TOOL,
      description: "Run Gemini subscription CLI with parallel execution. Model: leave `model` unset to use the provider default (the CLI's account routing); pass a model only if the operator has named one. Runs with YOLO approval and returns no auditable tool trace, so assign read-only work only.",
      inputSchema: zodToJsonSchema(GeminiInvokeSchema) as Tool["inputSchema"]
    },
    continue: {
      name: CONTINUE_TOOL,
      description: "Run Continue CLI agent with parallel execution. Requires CONTINUE_CONFIG_PATH and supports scoped working directories.",
      inputSchema: zodToJsonSchema(ContinueInvokeSchema) as Tool["inputSchema"]
    },
    grok: {
      name: GROK_TOOL,
      description: `Run native Grok Build using the existing grok.com subscription login. Inherited XAI_API_KEY and GROK_API_KEY are removed from the child environment. Model: leave \`model\` unset to use the default this server is configured with (currently ${GROK_DEFAULT_MODEL}, set in src/modelDefaults.ts; an operator setting, not a recommendation); pass a model only if the operator has named one. Result (JSON): final response, exit code, duration, the model used, and trace_path, a file holding full stdout/stderr. The CLI's plain output mode reports no token usage. Set trace: "full" on an input to also get raw stdout/stderr inline.`,
      inputSchema: zodToJsonSchema(GrokInvokeSchema) as Tool["inputSchema"]
    },
    deepseek: {
      name: DEEPSEEK_TOOL,
      description: "Run DeepSeek via plain chat-completions API. NO TOOL LAYER: cannot execute shell, read files, or verify anything - NEVER assign it audit or verification work; use it only for reasoning over text supplied in the prompt. Model: leave `model` unset to use the server's configured default; pass a model only if the operator has named one.",
      inputSchema: zodToJsonSchema(DeepSeekInvokeSchema) as Tool["inputSchema"]
    },
    ollama: {
      name: OLLAMA_TOOL,
      description: "Text-only chat to the local Ollama fleet (RE-Orch-01, RE-Orch-02, NAS). Supply a task class and omit host/model for health-checked fleet routing. Context defaults to 16384 to avoid RAM spill. This wrapper does not pass tools — that is a limit of this adapter, not the models. Qwen executes tools via: mandated tracked lane `REO/scripts/reo-local-digest.sh --tools --exec` or mcp__ollama-local__ollama_chat with tools[]. Use this wrapper for drafting, summarizing, classifying, embeddings. Load RAG entry 3ff6a0a1 (local-compute roster v2, 2026-09-03) for model guidance.",
      inputSchema: zodToJsonSchema(OllamaInvokeSchema) as Tool["inputSchema"]
    },
    multi: {
      name: MULTI_TOOL,
      description: "Run tasks across MULTIPLE providers in parallel. Each input specifies its own provider (codex/gemini/grok/deepseek/ollama), model, and prompt. All tasks execute concurrently up to the concurrency limit. Use this for cross-provider fan-out: e.g., send a security review to Grok while Codex implements the fix and DeepSeek validates the approach. Supports result caching per-task.",
      inputSchema: zodToJsonSchema(MultiInvokeSchema) as Tool["inputSchema"]
    },
    chain: {
      name: CHAIN_TOOL,
      description: "Run a sequential chain of steps across providers. Each step can use {{prev}} in its prompt to inject the previous step's output. Use for multi-step workflows: e.g., Grok analyzes code -> Codex implements fix -> Gemini writes tests. Max 10 steps. Stops on first error by default.",
      inputSchema: zodToJsonSchema(ChainInvokeSchema) as Tool["inputSchema"]
    },
    listAgents: {
      name: LIST_AGENTS_TOOL,
      description: "List all available specialized agents for use with codex, gemini, grok, and deepseek tools" + agentsList,
      inputSchema: zodToJsonSchema(z.object({})) as Tool["inputSchema"]
    }
  };
}

/** Compact JSON result for codex/grok: no raw event stream unless trace:"full". */
export function summaryResult(provider: string, result: AgentInvocationResult, index: number): Record<string, unknown> {
  const d = result.details ?? {};
  const common = {
    task: result.agent || `Task-${index + 1}`,
    provider: result.tool,
    status: result.status,
    exit_code: result.exitCode ?? null,
    duration_ms: result.durationMs ?? null,
    model: d.model ?? null,
    usage: d.usage ?? null,
    ...(d.usageNote ? { usage_note: d.usageNote } : {}),
    ...(d.filesChanged ? { files_changed: d.filesChanged } : {}),
    ...(d.commands ? { commands: d.commands } : {}),
    trace_path: d.tracePath ?? null
  };
  if (result.status === "ok") {
    return {
      ...common,
      final_message: result.response,
      ...(d.note ? { note: d.note } : {}),
      ...(d.rawStdout !== undefined ? { raw_stdout: d.rawStdout, raw_stderr: d.rawStderr } : {})
    };
  }
  return {
    ...common,
    error: result.error,
    ...(d.errorKind ? { error_kind: d.errorKind } : {}),
    ...(d.lastErrorEvent ? { last_error_event: d.lastErrorEvent } : {}),
    stderr_tail: d.stderrTail ?? "",
    ...(d.rawStdout !== undefined ? { raw_stdout: d.rawStdout, raw_stderr: d.rawStderr } : {})
  };
}

function summaryResponse(provider: string, concurrency: number, results: AgentInvocationResult[]) {
  const body = {
    tool: provider,
    concurrency,
    results: results.map((r, i) => summaryResult(provider, r, i)),
    trace_dir: traceDir(),
    trace_retention: retentionNote()
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) } satisfies TextContent]
  };
}

/** One-line facts for multi/chain text output. */
function detailLines(result: AgentInvocationResult): string[] {
  const d = result.details;
  if (!d) return [];
  const lines: string[] = [];
  if (d.model) lines.push(`Model: ${d.model.id ?? "unknown"} (${d.model.source})`);
  if (d.usage) lines.push(`Usage: ${JSON.stringify(d.usage)}`);
  if (d.tracePath) lines.push(`Trace: ${d.tracePath}`);
  if (d.lastErrorEvent) lines.push(`Last error event: ${JSON.stringify(d.lastErrorEvent)}`);
  if (d.stderrTail) lines.push(`Stderr (last ${d.stderrTail.length} chars):`, `  ${d.stderrTail.trim().split("\n").join("\n  ")}`);
  return lines;
}

const server = new Server(
  {
    name: "SuperAgent",
    version: "0.3.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// @ts-expect-error MCP SDK type mismatch
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = createToolDefinitions();
  return {
    tools: [tools.codex, tools.gemini, tools.continue, tools.grok, tools.deepseek, tools.ollama, tools.multi, tools.chain, tools.listAgents]
  };
});

// @ts-expect-error MCP SDK type mismatch
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // @ts-expect-error
  const { name: toolName, arguments: args = {} } = request.params;

  if (toolName === LIST_AGENTS_TOOL) {
    const agents = loadAgents();
    const agentList = agents
      .map(a => `• ${a.name}: ${a.description}`)
      .join('\n');

    return {
      content: [
        {
          type: "text",
          text: `Available specialized agents:\n\n${agentList}\n\nUse any of these agents with the 'agent' parameter in codex or gemini tools.`
        } satisfies TextContent
      ]
    };
  }

  if (toolName === CODEX_TOOL) {
    const parsed = CodexInvokeSchema.parse(args);
    const results = await runCodexBatch(parsed);
    return summaryResponse("codex", parsed.concurrency, results);
  } else if (toolName === GEMINI_TOOL) {
    const parsed = GeminiInvokeSchema.parse(args);
    const results = await runGeminiBatch(parsed);

    // Format results as clean text
    const resultParts: string[] = [];

    resultParts.push(`=== Gemini Agent Execution ===`);
    resultParts.push(`Concurrency: ${parsed.concurrency}`);
    resultParts.push(``);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const taskColor = TASK_COLORS[i % TASK_COLORS.length];
      const taskName = result.agent || `Task-${i + 1}`;

      if (result.status === "ok") {
        resultParts.push(`${taskColor}━━━ Task: ${taskName} ━━━${RESET_COLOR}`);
        resultParts.push(`Status: ✓ Success (${result.durationMs}ms)`);
        resultParts.push(`Response:`);
        if (result.response) {
          resultParts.push(`  ${result.response.split('\n').join('\n  ')}`);
        }

        // Show raw output if includeRawEvents is true
        if (result.rawOutput) {
          resultParts.push(`\n[Raw JSON Events - First 5 lines]`);
          const lines = result.rawOutput.split('\n').filter(l => l.trim());
          lines.slice(0, 5).forEach(line => {
            resultParts.push(`  ${line}`);
          });
          if (lines.length > 5) {
            resultParts.push(`  ... (${lines.length - 5} more lines)`);
          }
        }

        resultParts.push(``);
      } else {
        resultParts.push(`${taskColor}━━━ Task: ${taskName} ━━━${RESET_COLOR}`);
        resultParts.push(`Status: ✗ Failed`);
        if (result.error) {
          resultParts.push(`Error:`);
          resultParts.push(`  ${result.error.split('\n').join('\n  ')}`);
        }
        if (result.stderr) {
          resultParts.push(`Stderr:`);
          resultParts.push(`  ${result.stderr.trim().split('\n').slice(0, 10).join('\n  ')}`);
        }
        if (result.rawOutput) {
          resultParts.push(`Output:`);
          resultParts.push(`  ${result.rawOutput.trim().split('\n').slice(0, 10).join('\n  ')}`);
        }
        resultParts.push(``);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: resultParts.join("\n")
        } satisfies TextContent
      ]
    };
  } else if (toolName === CONTINUE_TOOL) {
    const parsed = ContinueInvokeSchema.parse(args);
    const results = await runContinueBatch(parsed);
    const resultParts: string[] = [
      "=== Continue Agent Execution ===",
      `Concurrency: ${parsed.concurrency}`,
      ""
    ];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const taskColor = TASK_COLORS[i % TASK_COLORS.length];
      const taskName = result.agent || `Task-${i + 1}`;
      resultParts.push(`${taskColor}━━━ Task: ${taskName} ━━━${RESET_COLOR}`);
      if (result.status === "ok") {
        resultParts.push(`Status: ✓ Success (${result.durationMs}ms)`, "Response:");
        if (result.response) resultParts.push(`  ${result.response.split("\n").join("\n  ")}`);
      } else {
        resultParts.push("Status: ✗ Failed");
        if (result.error) resultParts.push("Error:", `  ${result.error.split("\n").join("\n  ")}`);
      }
      resultParts.push("");
    }
    return { content: [{ type: "text", text: resultParts.join("\n") } satisfies TextContent] };
  } else if (toolName === GROK_TOOL) {
    const parsed = GrokInvokeSchema.parse(args);
    const results = await runGrokBatch(parsed);
    return summaryResponse("grok", parsed.concurrency, results);
  } else if (toolName === DEEPSEEK_TOOL) {
    const parsed = DeepSeekInvokeSchema.parse(args);
    const results = await runDeepSeekBatch(parsed);

    // Format results as clean text
    const resultParts: string[] = [];

    resultParts.push(`=== DeepSeek Agent Execution ===`);
    resultParts.push(`Concurrency: ${parsed.concurrency}`);
    resultParts.push(``);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const taskColor = TASK_COLORS[i % TASK_COLORS.length];
      const taskName = result.agent || `Task-${i + 1}`;

      if (result.status === "ok") {
        resultParts.push(`${taskColor}━━━ Model: ${taskName} ━━━${RESET_COLOR}`);
        resultParts.push(`Status: ✓ Success (${result.durationMs}ms)`);
        resultParts.push(`Response:`);
        if (result.response) {
          resultParts.push(`  ${result.response.split('\n').join('\n  ')}`);
        }
        resultParts.push(``);
      } else {
        resultParts.push(`${taskColor}━━━ Model: ${taskName} ━━━${RESET_COLOR}`);
        resultParts.push(`Status: ✗ Failed`);
        if (result.error) {
          resultParts.push(`Error:`);
          resultParts.push(`  ${result.error.split('\n').join('\n  ')}`);
        }
        if (result.stderr) {
          resultParts.push(`Stderr:`);
          resultParts.push(`  ${result.stderr.trim().split('\n').slice(0, 10).join('\n  ')}`);
        }
        if (result.rawOutput) {
          resultParts.push(`Output:`);
          resultParts.push(`  ${result.rawOutput.trim().split('\n').slice(0, 10).join('\n  ')}`);
        }
        resultParts.push(``);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: resultParts.join("\n")
        } satisfies TextContent
      ]
    };
  } else if (toolName === OLLAMA_TOOL) {
    const parsed = OllamaInvokeSchema.parse(args);
    const results = await runOllamaBatch(parsed);

    // Format results as clean text
    const resultParts: string[] = [];

    resultParts.push(`=== Ollama Local Inference ===`);
    resultParts.push(`Concurrency: ${parsed.concurrency}`);
    const pinnedHosts = [...new Set(parsed.inputs.map((input) => input.host).filter(Boolean))];
    resultParts.push(pinnedHosts.length > 0
      ? `Pinned host(s): ${pinnedHosts.join(", ")}`
      : "Routing: health-checked local fleet");
    resultParts.push(``);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const taskColor = TASK_COLORS[i % TASK_COLORS.length];
      const taskName = result.agent || `Task-${i + 1}`;

      if (result.status === "ok") {
        resultParts.push(`${taskColor}━━━ Model: ${taskName} ━━━${RESET_COLOR}`);
        resultParts.push(`Status: ✓ Success (${result.durationMs}ms)`);
        resultParts.push(`Response:`);
        if (result.response) {
          resultParts.push(`  ${result.response.split('\n').join('\n  ')}`);
        }
        resultParts.push(``);
      } else {
        resultParts.push(`${taskColor}━━━ Model: ${taskName} ━━━${RESET_COLOR}`);
        resultParts.push(`Status: ✗ Failed`);
        if (result.error) {
          resultParts.push(`Error:`);
          resultParts.push(`  ${result.error.split('\n').join('\n  ')}`);
        }
        if (result.stderr) {
          resultParts.push(`Stderr:`);
          resultParts.push(`  ${result.stderr.trim().split('\n').slice(0, 10).join('\n  ')}`);
        }
        if (result.rawOutput) {
          resultParts.push(`Output:`);
          resultParts.push(`  ${result.rawOutput.trim().split('\n').slice(0, 10).join('\n  ')}`);
        }
        resultParts.push(``);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: resultParts.join("\n")
        } satisfies TextContent
      ]
    };
  } else if (toolName === MULTI_TOOL) {
    const parsed = MultiInvokeSchema.parse(args);
    const results = await runMultiBatch(parsed);

    const resultParts: string[] = [];
    resultParts.push(`=== Multi-Provider Execution ===`);
    resultParts.push(`Tasks: ${results.length} | Concurrency: ${parsed.concurrency}`);
    resultParts.push(`Providers: ${[...new Set(parsed.inputs.map(i => i.provider))].join(', ')}`);
    resultParts.push(``);

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const input = parsed.inputs[i];
      const taskColor = TASK_COLORS[i % TASK_COLORS.length];
      const taskName = result.agent || `${input.provider}/${input.model || 'default'}`;

      if (result.status === "ok") {
        successCount++;
        resultParts.push(`${taskColor}━━━ [${input.provider.toUpperCase()}] ${taskName} ━━━${RESET_COLOR}`);
        resultParts.push(`Status: ✓ Success (${result.durationMs}ms)`);
        resultParts.push(...detailLines(result));
        resultParts.push(`Response:`);
        if (result.response) {
          resultParts.push(`  ${result.response.split('\n').join('\n  ')}`);
        }
        resultParts.push(``);
      } else {
        errorCount++;
        resultParts.push(`${taskColor}━━━ [${input.provider.toUpperCase()}] ${taskName} ━━━${RESET_COLOR}`);
        resultParts.push(`Status: ✗ Failed`);
        resultParts.push(...detailLines(result));
        if (result.error) {
          resultParts.push(`Error:`);
          resultParts.push(`  ${result.error.split('\n').join('\n  ')}`);
        }
        if (result.stderr) {
          resultParts.push(`Stderr:`);
          resultParts.push(`  ${result.stderr.trim().split('\n').slice(0, 10).join('\n  ')}`);
        }
        if (result.rawOutput) {
          resultParts.push(`Output:`);
          resultParts.push(`  ${result.rawOutput.trim().split('\n').slice(0, 10).join('\n  ')}`);
        }
        resultParts.push(``);
      }
    }

    resultParts.push(`=== Summary: ${successCount} succeeded, ${errorCount} failed ===`);

    return {
      content: [
        {
          type: "text",
          text: resultParts.join("\n")
        } satisfies TextContent
      ]
    };
  } else if (toolName === CHAIN_TOOL) {
    const parsed = ChainInvokeSchema.parse(args);
    const results = await runChain(parsed);

    const resultParts: string[] = [];
    resultParts.push(`=== Chain Execution (${results.length}/${parsed.steps.length} steps) ===`);
    resultParts.push(`Stop on error: ${parsed.stopOnError}`);
    resultParts.push(``);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const step = parsed.steps[i];
      const taskColor = TASK_COLORS[i % TASK_COLORS.length];
      const stepLabel = result.agent || `${step.provider}/${step.model || 'default'}`;

      if (result.status === "ok") {
        resultParts.push(`${taskColor}━━━ Step ${i + 1}: [${step.provider.toUpperCase()}] ${stepLabel} ━━━${RESET_COLOR}`);
        resultParts.push(`Status: ✓ Success (${result.durationMs}ms)`);
        resultParts.push(...detailLines(result));
        resultParts.push(`Response:`);
        if (result.response) {
          resultParts.push(`  ${result.response.split('\n').join('\n  ')}`);
        }
        resultParts.push(``);
      } else {
        resultParts.push(`${taskColor}━━━ Step ${i + 1}: [${step.provider.toUpperCase()}] ${stepLabel} ━━━${RESET_COLOR}`);
        resultParts.push(`Status: ✗ Failed`);
        resultParts.push(...detailLines(result));
        if (result.error) {
          resultParts.push(`Error:`);
          resultParts.push(`  ${result.error.split('\n').join('\n  ')}`);
        }
        if (result.stderr) {
          resultParts.push(`Stderr:`);
          resultParts.push(`  ${result.stderr.trim().split('\n').slice(0, 10).join('\n  ')}`);
        }
        if (result.rawOutput) {
          resultParts.push(`Output:`);
          resultParts.push(`  ${result.rawOutput.trim().split('\n').slice(0, 10).join('\n  ')}`);
        }
        resultParts.push(``);
        if (parsed.stopOnError) {
          resultParts.push(`[Chain halted — stopOnError is true]`);
        }
      }
    }

    const totalMs = results.reduce((sum, r) => sum + ('durationMs' in r ? (r.durationMs || 0) : 0), 0);
    const succeeded = results.filter(r => r.status === "ok").length;
    resultParts.push(`=== Chain complete: ${succeeded}/${results.length} steps succeeded (${totalMs}ms total) ===`);

    return {
      content: [
        {
          type: "text",
          text: resultParts.join("\n")
        } satisfies TextContent
      ]
    };
  } else {
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: ${toolName}`
        }
      ],
      isError: true
    };
  }
});

async function main() {
  setupSignalHandlers();

  // Ensure agents directory exists
  ensureAgentsDirectory();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SuperAgent MCP server v0.3.0 ready (Codex, Gemini, Grok, DeepSeek, Ollama + Multi & Chain)");
}

main().catch((error: unknown) => {
  console.error("SuperAgent MCP server failed to start", error);
  process.exit(1);
});
