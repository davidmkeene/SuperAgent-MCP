#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  TextContent
} from "@modelcontextprotocol/sdk/types.js";
import { CodexInvokeSchema, GeminiInvokeSchema, GrokInvokeSchema, DeepSeekInvokeSchema, OllamaInvokeSchema, MultiInvokeSchema, ChainInvokeSchema } from "./types.js";
import { runCodexBatch, runGeminiBatch, runGrokBatch, runDeepSeekBatch, runOllamaBatch, runMultiBatch, runChain } from "./runner.js";
import { formatAgentsForDescription, ensureAgentsDirectory, loadAgents } from "./agentLoader.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { collectCostReceipts, receiptMetadata } from "./accounting.js";

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
const GROK_TOOL = "grok";
const DEEPSEEK_TOOL = "deepseek";
const OLLAMA_TOOL = "ollama";
const MULTI_TOOL = "multi";
const CHAIN_TOOL = "chain";

// Dynamically create tool definitions with available agents
const LIST_AGENTS_TOOL = "list-agents";

function createToolDefinitions(): { codex: Tool, gemini: Tool, grok: Tool, deepseek: Tool, ollama: Tool, multi: Tool, chain: Tool, listAgents: Tool } {
  const agentsList = formatAgentsForDescription();

  return {
    codex: {
      name: CODEX_TOOL,
      description: "Run Codex CLI agent with parallel execution. Codex has REAL shell access and returns a command_execution trace with exit codes, so its work is auditable. Use 'workingDirectory' to target a project. MODELS (verified 2026-08-11, codex-cli 0.147.0): gpt-5.3-codex = VERIFIED WORKING, executes shell in ~3s - USE THIS. o4-mini = BROKEN, do not use: it loops empty web searches, burns ~20k tokens and returns CANNOT_EXECUTE without running anything. o3 / gpt-5-codex-mini = unverified. A 'Model metadata not found' warning is benign and does not mean the model failed.",
      inputSchema: zodToJsonSchema(CodexInvokeSchema) as Tool["inputSchema"]
    },
    gemini: {
      name: GEMINI_TOOL,
      description: "Run Gemini CLI agent with parallel execution. Has real shell access BUT runs with -y (YOLO) auto-approving every action AND returns no tool-call trace, so what it did cannot be audited afterwards - NEVER give it tasks that can mutate production. Models (gemini CLI 0.18.4): gemini-2.5-flash (default), gemini-2.5-flash-lite (cheapest), gemini-2.5-pro (quota-limited). BEST-EFFORT ONLY: daily quota was observed exhausted on 2026-08-11 mid-session, so always have a fallback provider. Good for: bulk local code drafting and read-only analysis.",
      inputSchema: zodToJsonSchema(GeminiInvokeSchema) as Tool["inputSchema"]
    },
    grok: {
      name: GROK_TOOL,
      description: "Run xAI Grok CLI agent with parallel execution. PREFERRED for audit/verification work: it has real shell access AND returns the full bash tool-call trace, so you can confirm it actually ran the command instead of inventing the answer. Fastest of the CLI agents (~2-3s). MODELS (live from `grok models`, verified 2026-08-11): grok-build-latest = CLI default, self-updating alias, best for build/coding. grok-4.5 = NEWEST reasoning model. grok-4.3 = previous reasoning flagship. grok-4.20-0309-reasoning / -non-reasoning / grok-4.20-multi-agent-0309. grok-build-0.1 = pinned, superseded by grok-build-latest. DEAD, do NOT use (xAI no longer advertises them): grok-4-latest, grok-code-fast-1, grok-3-mini, grok-4-1-fast-latest.",
      inputSchema: zodToJsonSchema(GrokInvokeSchema) as Tool["inputSchema"]
    },
    deepseek: {
      name: DEEPSEEK_TOOL,
      description: "Run DeepSeek via plain chat-completions API. NO TOOL LAYER: cannot execute shell, read files, or verify anything - NEVER assign it audit or verification work. MODELS (live list from /models, verified 2026-08-11): deepseek-v4-pro (current flagship, chain-of-thought, DEFAULT) and deepseek-v4-flash (fast/cheap). Legacy deepseek-chat / deepseek-reasoner are no longer published. WARNING verified by test: deepseek-chat FABRICATED realistic fake command output ('fatal: not a git repository') for a directory that IS a git repo, while deepseek-v4-pro correctly answered CANNOT_EXECUTE. Use v4-pro, and only for reasoning over text supplied in the prompt.",
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
    tools: [tools.codex, tools.gemini, tools.grok, tools.deepseek, tools.ollama, tools.multi, tools.chain, tools.listAgents]
  };
});

// @ts-expect-error MCP SDK type mismatch
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const attribution: Record<string, string> = {};
  // Per-request attribution only; a shared MCP process must not borrow a
  // globally active task or another client's session.
  const supplied = (request as any).params._meta?.["reo/context"];
  for (const key of ["session_id", "task_id", "project_id", "tenant_id"]) {
    if (typeof supplied?.[key] === "string" && supplied[key]) attribution[key] = supplied[key];
  }
  const { result, receipts } = await collectCostReceipts(async () => {
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

    // Format results as clean text
    const resultParts: string[] = [];

    resultParts.push(`=== Codex Agent Execution ===`);
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
  } else if (toolName === GROK_TOOL) {
    const parsed = GrokInvokeSchema.parse(args);
    const results = await runGrokBatch(parsed);

    // Format results as clean text
    const resultParts: string[] = [];

    resultParts.push(`=== Grok Agent Execution ===`);
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
        resultParts.push(`Response:`);
        if (result.response) {
          resultParts.push(`  ${result.response.split('\n').join('\n  ')}`);
        }
        resultParts.push(``);
      } else {
        errorCount++;
        resultParts.push(`${taskColor}━━━ [${input.provider.toUpperCase()}] ${taskName} ━━━${RESET_COLOR}`);
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
        resultParts.push(`Response:`);
        if (result.response) {
          resultParts.push(`  ${result.response.split('\n').join('\n  ')}`);
        }
        resultParts.push(``);
      } else {
        resultParts.push(`${taskColor}━━━ Step ${i + 1}: [${step.provider.toUpperCase()}] ${stepLabel} ━━━${RESET_COLOR}`);
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
  }, attribution);
  return { ...result, _meta: { "reo/cost_receipts": receiptMetadata(receipts) } };
});

async function main() {
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
