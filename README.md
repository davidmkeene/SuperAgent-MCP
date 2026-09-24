# SuperAgent MCP

SuperAgent is a Model Context Protocol (MCP) server that bridges MCP-compatible clients with the Codex and Gemini CLI agents. It lets you fan out multiple CLI tasks in parallel, reuse curated system prompts, and surface results back to your client in a single, structured response.

## REO CLI cost receipts

Codex, Grok and Gemini capture terminal usage per CLI attempt, including failed
attempts and retries. Codex uses JSON events and pins the model read from
`$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) unless explicitly
overridden. Gemini emits one receipt per reported model. A missing usage split
or unresolved model produces `usage_known=false`, a path-specific reason, and
a warning on stderr.

For automatic `report_cost` delivery, set `SUPERAGENT_REO_MCP_CONFIG` in the MCP
server environment to the existing `.mcp.json` containing the `orchestrator-rag`
HTTP URL and headers. Credentials are read from that file and never logged.
Clients can supply per-call attribution in `_meta["reo/context"]` with
`session_id`, `task_id`, `project_id`, and `tenant_id`; omitted values remain
unset, never taken from another session's task pointer.

Each response includes `_meta["reo/cost_receipts"]` with delivery status and
metadata. Decode `payload_base64` as base64 UTF-8 JSON to obtain the exact
`report_cost` arguments. The encoding prevents the legacy recursive usage hook
from billing an already-posted receipt a second time. Retry a failed delivery
with the **same payload and request_id**; do not rerun inference. The current REO
API has no metadata/reason arguments, so alias/reason are also encoded in its
persisted request ID. Human-readable response text contains no cost JSON.

`SUPERAGENT_COST_MODE=capture` prevents all posting for offline validation.
Missing configuration or an unacknowledged post logs `COST RECEIPT NOT POSTED`
and marks delivery `failed`. Build with `npm run build`, run offline tests with
`npm test`, then restart the MCP process to load code changes. The live test is
opt-in: `RUN_CODEX_USAGE_INTEGRATION=1 CODEX_INTEGRATION_BINARY=/path/to/native/codex npm run test:integration`.

## Features
- **Unified agent runner**: expose the Codex and Gemini CLIs as MCP tools without additional wrappers.
- **Parallel execution**: run multiple prompts concurrently with per-task timeouts and basic result formatting.
- **Agent library sync**: ship ready-made system prompts that install into `~/.superagent/agents` and can be extended locally.
- **Tool discovery**: query the bundled `list-agents` tool to see which specialized agents are available at runtime.

## Installation

```bash
npm install @superclaude-org/superagent
```

The postinstall script seeds any missing agent definition files under `~/.superagent/agents` so they are immediately 

Once connected, the client will discover these tools:

| Tool | Purpose | Notable arguments |
| --- | --- | --- |
| `codex` | Run one or many Codex CLI tasks in parallel. | `inputs[]` (prompt list), `concurrency`, `workingDirectory`, `agent`, `extraArgs`, `timeoutMs` |
| `gemini` | Run Gemini CLI tasks with auto-approval enabled. | `inputs[]`, `concurrency`, `workingDirectory`, `agent`, `timeoutMs` |
| `list-agents` | List the specialized agents available to both tools. | *(none)* |

### Invoking a tool
```json
{
  "tool": "codex",
  "arguments": {
    "concurrency": 2,
    "inputs": [
      { "prompt": "Run unit tests", "workingDirectory": "/path/to/app" },
      { "prompt": "Summarize latest git changes", "agent": "technical-writer" }
    ]
  }
}
```

## Agent Management
- Agent definitions are Markdown files with frontmatter. You can edit or add new files in `~/.superagent/agents`.
- The `list-agents` tool shows each agent’s name and description so you can supply the `agent` field when invoking `codex` or `gemini`.
- Files shipped with the package are copied only if they do not already exist, preserving local customizations.

## Development

```bash
npm install
npm run build
npm start   # runs the compiled server
npm run dev # runs the TypeScript entrypoint with ts-node
```

Requires Node.js 18 or newer.
