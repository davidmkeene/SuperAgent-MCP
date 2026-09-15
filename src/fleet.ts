/**
 * Local inference fleet — host definitions and a simple router.
 *
 * Hardware was measured on 2026-08-11; model presence was rechecked live on 2026-09-01:
 *   lscpu / free -g / lspci -nn / nvidia-smi / GET :11434/api/tags / POST :11434/api/show
 *
 * WHY THIS EXISTS: three capable boxes were sitting idle while work was routed to paid
 * cloud APIs. The V100s were at 0% utilisation. This file makes local capacity the
 * default and encodes which box is safe to load.
 */

export type Accel = "cuda" | "rocm-igpu" | "vulkan-igpu" | "cpu";
export type TaskClass =
  | "embed"          // vector embeddings
  | "classify"       // short label/extract/route decisions
  | "summarize"      // condense logs, diffs, docs
  | "draft"          // write code/config/tests from a spec
  | "code-review"    // review a diff for defects
  | "reason"         // hard multi-step analysis
  | "agentic";       // needs native tool/function calling

export interface FleetHost {
  id: string;
  endpoint: string;
  hostname: string;
  cpu: string;
  cores: number;
  ramGB: number;
  accel: Accel;
  /** Usable accelerator memory in GB. For iGPUs this is carved from system RAM. */
  accelMemGB: number;
  accelDetail: string;
  /** Largest model (GB on disk) this host should be asked to hold. */
  maxModelGB: number;
  /** Lower = prefer more. */
  cost: number;
  /** Production workload sharing this box — throttle or avoid if set. */
  sharedWith?: string;
  notes: string;
}

export const FLEET: Record<string, FleetHost> = {
  orch01: {
    id: "orch01",
    endpoint: "http://192.168.1.100:11434",
    hostname: "RE-ORCHESTRATOR-01",
    cpu: "AMD Ryzen Threadripper PRO 9955WX",
    cores: 32,
    ramGB: 125,
    accel: "cuda",
    accelMemGB: 64,
    accelDetail:
      "2x Tesla V100-SXM2-32GB (PCIe interposers, NO NVLink), driver 580.126.09. " +
      "A Radeon PRO W6600 is also present but is the DISPLAY adapter only — not for inference. " +
      "Kernel carries pci-stub.ids=10de:1db4 (V100 PCIe 16GB) but no such card is installed; the stub is vestigial.",
    maxModelGB: 60,
    cost: 1,
    sharedWith: "grafana, prometheus, ltui, headscale (all light)",
    notes:
      "THE HEAVY BOX. Only host that can hold 70B-class models. Real CUDA. " +
      "CAUTION: nvidia DKMS is broken for kernels newer than 6.17.0-35 — do not upgrade the kernel here.",
  },

  nas: {
    id: "nas",
    endpoint: "http://192.168.1.20:11434",
    hostname: "re-nas01",
    cpu: "AMD Ryzen AI 9 HX PRO 370 w/ Radeon 890M",
    cores: 24,
    ramGB: 91,
    accel: "vulkan-igpu",
    accelMemGB: 42,
    accelDetail:
      "Radeon 890M (Strix, gfx1150) iGPU with unified memory, driven through VULKAN (RADV) since 2026-09-03. " +
      "Container: ollama/ollama:latest (0.33.3) with OLLAMA_VULKAN=1 + --device /dev/dri only. " +
      "The previous ollama/ollama:rocm container emitted garbage under every HSA_OVERRIDE_GFX_VERSION " +
      "(11.0.0/11.0.2/11.5.0) — ROCm is BROKEN for gfx1150 here; it is kept stopped as ollama-rocm-old for rollback. " +
      "Verified 2026-09-03: qwen2.5:7b 18.7 tok/s, qwen2.5:14b tool_calls OK at 8.8 tok/s, 49/49 layers on GPU, 42 GB visible.",
    maxModelGB: 40,
    cost: 3,
    sharedWith: "RE:Aria PRODUCTION, Frigate NVR + cameras",
    notes:
      "DO NOT SATURATE. This box runs Aria production and Frigate recording. " +
      "Role per operator 2026-09-03: embeddings + LONG-RUNNING BACKGROUND analysis (RAG restructuring, batch review) " +
      "where latency does not matter — a 32B/70B Q4 fits in unified memory at ~4/~2 tok/s. " +
      "Never interactive bulk work; the router keeps it embed-only unless the caller passes sparePriorityHost=false. " +
      "OLLAMA_NUM_PARALLEL=2, MAX_LOADED_MODELS=2, KEEP_ALIVE=30m, CONTEXT_LENGTH=32768.",
  },

  orch02: {
    id: "orch02",
    endpoint: "http://192.168.1.10:11434",
    hostname: "RE-Orchestrator-02",
    cpu: "AMD Ryzen AI 9 HX 370 w/ Radeon 890M",
    cores: 24,
    ramGB: 60,
    accel: "rocm-igpu",
    accelMemGB: 34,
    accelDetail:
      "Radeon 890M iGPU via ROCm (native ollama 0.33.1, rocm_v7_2, HSA_OVERRIDE_GFX_VERSION=11.0.0, OLLAMA_IGPU_ENABLE=1). " +
      "Unlike the NAS, ROCm output is CORRECT here (Debian 12 kernel 6.12.57). GTT cap 34.4 GB bounds GPU-visible memory. " +
      "Verified 2026-09-03: qwen2.5:14b 49/49 layers on GPU at 8.2 tok/s (112 prompt tok/s); qwen3:8b tool_calls 15 tok/s; " +
      "nemotron-3.5-lightning:30b-a3b tool_calls OK (~40 s cold). The XDNA NPU is not used by Ollama.",
    maxModelGB: 28,
    cost: 2,
    notes:
      "Lightest production burden of the three, so the safest box for small parallel work. " +
      "Tuned 2026-09-03 (zz-tuning-20260903.conf): KEEP_ALIVE=30m, MAX_LOADED_MODELS=2, CONTEXT_LENGTH=16384, NUM_PARALLEL=2. " +
      "Models up to ~28 GB are fine (nemotron 30b-a3b, qwen2.5-coder:14b); 70B-class stays on orch01.",
  },

  // Dedicated sidecar lanes on the orch01 box (registered 2026-09-15, REPORT.md §9.2 R-1).
  // Same physical hardware as `orch01` — NOT independent capacity — so they are pin-only:
  // the default hostRank()/route() ranking leaves unknown ids at rank 99, meaning normal
  // task routing still prefers orch01/orch02/nas exactly as before. Reach these lanes only
  // via `pinHost: "orch01long"` / `pinHost: "orch01cpu"`.
  orch01long: {
    id: "orch01long",
    endpoint: "http://192.168.1.100:11437",
    hostname: "RE-ORCHESTRATOR-01",
    cpu: "AMD Ryzen Threadripper PRO 9955WX",
    cores: 32,
    ramGB: 125,
    accel: "cuda",
    accelMemGB: 64,
    accelDetail:
      "Same 2x Tesla V100-SXM2-32GB as orch01 — this is a SEPARATE ollama-cli.service instance on " +
      "the same box (:11437, KEEP_ALIVE=24h), dedicated to long-context work: qwen-cli:200k, the " +
      "same qwen3.8:27b weights with num_ctx 204800. Needle-verified 2026-09-15: a 79,419-token " +
      "prompt answered correctly in 159.6s (~499 tok/s ingest; ~7 min before generation starts on " +
      "a full 200k prompt).",
    maxModelGB: 60,
    cost: 1,
    sharedWith: "orch01 (same 2x V100s — GPU memory is shared; do not assume both instances can load their heaviest models at once)",
    notes:
      "DEDICATED LONG-CONTEXT LANE. Only holds qwen-cli:200k. Pin explicitly (pinHost: \"orch01long\") " +
      "for --ctx long / big single-shot reasoning jobs; not part of normal task-class ranking.",
  },

  orch01cpu: {
    id: "orch01cpu",
    endpoint: "http://192.168.1.100:11438",
    hostname: "RE-ORCHESTRATOR-01",
    cpu: "AMD Ryzen Threadripper PRO 9955WX",
    cores: 32,
    ramGB: 125,
    accel: "cpu",
    accelMemGB: 0,
    accelDetail:
      "CPU-only ollama instance on the same box as orch01 (CUDA_VISIBLE_DEVICES=-1, :11438). Runs " +
      "qwen-orch-cpu:latest (qwen3:30b-a3b Q4 MoE). Architecture context 262144 via 125 GB ECC RAM, " +
      "not VRAM; live tag num_ctx is 16384 inside a 40G cgroup. SLOW.",
    maxModelGB: 40,
    cost: 5,
    sharedWith: "orch01 (same CPU/RAM; operator-triggered via reo_job_queues \"cpu-orch\" — do not steal local-fleet-queue-wg members)",
    notes:
      "OVERNIGHT / BATCH ONLY. Pin explicitly (pinHost: \"orch01cpu\"); not part of normal " +
      "task-class ranking (slow: ~40 tok/s).",
  },
};

/** Models present per host, verified via /api/tags on 2026-09-03 (routing audit). */
export interface FleetModel {
  name: string;
  sizeGB: number;
  hosts: string[];
  /** Ollama /api/show reports the "tools" capability. CLAIMED, not proven. */
  tools: boolean;
  /**
   * Empirically confirmed to emit STRUCTURED message.tool_calls on /api/chat.
   *
   * This is deliberately separate from `tools`. Tested 2026-08-11 with a
   * get_weather function schema:
   *   qwen3:30b-a3b  -> tool_calls: [{function:{name:"get_weather",arguments:{city:"Paris"}}}]  PASS
   *   qwen3:8b       -> same, PASS
   *   qwen2.5-coder:32b -> tool_calls NONE; emitted the call as plain text in
   *                        message.content: '{"name":"get_weather","arguments":{"city":"Paris"}}'
   *                        i.e. it ADVERTISES tools and does not deliver them.
   * Only route agentic work to models where this is true.
   */
  toolsVerified?: boolean;
  good: TaskClass[];
}

export const MODELS: FleetModel[] = [
  // ---- orch01 only (need real VRAM) ----
  { name: "nemotron-3.5-lightning:30b-a3b-q4_K_M", sizeGB: 18.6, hosts: ["orch01", "orch02"], tools: true, toolsVerified: true, good: ["agentic", "reason"] },
  { name: "qwen3.8:27b",                       sizeGB: 17.0, hosts: ["orch01"], tools: true, toolsVerified: true, good: ["agentic", "reason", "summarize", "draft"] },
  { name: "qwen2.5:72b",                      sizeGB: 47.4, hosts: ["orch01"], tools: true,  good: ["reason"] },
  { name: "llama3.1:70b",                     sizeGB: 42.5, hosts: ["orch01"], tools: true,  good: ["reason"] },
  // NOTE: coder:32b advertises tools but does NOT emit structured tool_calls — see
  // toolsVerified doc above. Kept for code-review/draft, removed from agentic.
  { name: "qwen2.5-coder:32b-instruct-q4_K_M",sizeGB: 19.9, hosts: ["orch01"], tools: true,  toolsVerified: false, good: ["code-review", "draft"] },
  { name: "qwen2.5:32b",                      sizeGB: 19.9, hosts: ["orch01"], tools: true,  good: ["reason", "summarize"] },
  { name: "qwen3:30b-a3b",                    sizeGB: 18.6, hosts: ["orch01"], tools: true,  toolsVerified: true, good: ["agentic", "reason"] },
  { name: "gemma2:27b-instruct-q4_K_M",       sizeGB: 16.6, hosts: ["orch01"], tools: false, good: ["summarize", "draft"] },
  { name: "codestral:22b",                    sizeGB: 12.6, hosts: ["orch01"], tools: false, good: ["draft"] },
  { name: "deepseek-coder-v2:16b",            sizeGB: 8.9,  hosts: ["orch01"], tools: false, good: ["code-review", "draft"] },

  // ---- small, spread across boxes ----
  { name: "qwen3:8b",                         sizeGB: 5.2,  hosts: ["orch01", "orch02"], tools: true,  toolsVerified: true, good: ["agentic", "reason", "summarize", "draft"] },
  { name: "qwen2.5:14b",                      sizeGB: 9.0,  hosts: ["nas", "orch02"], tools: true, good: ["summarize", "reason", "classify"] },
  { name: "qwen2.5-coder:7b",                 sizeGB: 4.7,  hosts: ["nas", "orch02"], tools: true, good: ["draft", "classify"] },

  { name: "qwen2.5-coder:14b",                sizeGB: 9.0,  hosts: ["orch02"], tools: true,  good: ["code-review", "draft"] },
  { name: "qwen2.5-coder:7b-instruct-q4_K_M", sizeGB: 4.7,  hosts: ["orch01"], tools: true,  good: ["draft", "classify"] },
  { name: "qwen2.5:7b",                       sizeGB: 4.7,  hosts: ["nas", "orch02"], tools: true, good: ["classify", "summarize"] },
  { name: "llama3.2:3b",                      sizeGB: 2.0,  hosts: ["orch02"], tools: true,  good: ["classify"] },

  // ---- orch01 dedicated sidecar lanes (:11437 / :11438) — pin-only, see FLEET notes above ----
  { name: "qwen-cli:200k",                    sizeGB: 17.0, hosts: ["orch01long"], tools: true, toolsVerified: true, good: ["agentic", "reason", "summarize", "draft"] },
  { name: "qwen-orch-cpu",                    sizeGB: 18.6, hosts: ["orch01cpu"],  tools: true, toolsVerified: true, good: ["reason", "summarize", "draft"] },

  // ---- embeddings ----
  { name: "bge-m3:latest",                    sizeGB: 1.2,  hosts: ["orch01", "orch02"], tools: false, good: ["embed"] },
  { name: "nomic-embed-text:latest",          sizeGB: 0.3,  hosts: ["orch01", "nas", "orch02"], tools: false, good: ["embed"] },
];

export interface RouteResult {
  host: FleetHost;
  model: string;
  endpoint: string;
  reason: string;
}

export interface RouteOpts {
  /** Must the model support native tool calling? */
  needsTools?: boolean;
  /** Keep the NAS out of it (default true — it runs Aria production). */
  sparePriorityHost?: boolean;
  /** Force a host id. */
  pinHost?: string;
  /** Route even to hosts a previous probeFleet() marked unreachable. */
  ignoreHealth?: boolean;
}

/**
 * Pick a host+model for a task class.
 *
 * Policy, in order:
 *   1. honour pinHost if given
 *   2. drop models lacking tools when needsTools
 *   3. keep only models whose host can actually hold them (maxModelGB)
 *   4. avoid the NAS by default — Aria production and Frigate live there
 *   5. for heavy classes prefer the biggest capable model; otherwise prefer cheapest host
 */
/** Hosts marked unreachable by probeFleet(). Empty until a probe runs. */
const unhealthy = new Set<string>();

/**
 * Probe every host's /api/tags. Hosts that fail are excluded from routing until
 * the next successful probe. Without this the router happily returns a host that
 * is powered off — which is exactly what happened during the 2026-08-10 outage.
 */
export async function probeFleet(timeoutMs = 4000): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  await Promise.all(
    Object.values(FLEET).map(async (h) => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        const r = await fetch(`${h.endpoint}/api/tags`, { signal: ctl.signal });
        clearTimeout(t);
        out[h.id] = r.ok;
        if (r.ok) unhealthy.delete(h.id);
        else unhealthy.add(h.id);
      } catch {
        out[h.id] = false;
        unhealthy.add(h.id);
      }
    }),
  );
  return out;
}

/**
 * Per-task host preference. THIS is what spreads load — cost alone always picked
 * orch01 and left the other two boxes idle (found by Codex review 2026-08-11).
 *   heavy work  -> orch01 (the only real CUDA box)
 *   light work  -> orch02 (lightest production burden, safest to load)
 *   embeddings  -> nas    (cheap, and co-located with Aria's data)
 */
function hostRank(task: TaskClass, hostId: string): number {
  const order =
    task === "embed"
      ? ["nas", "orch02", "orch01"]
      : task === "classify" || task === "draft" || task === "summarize"
        ? ["orch02", "orch01", "nas"]
        : ["orch01", "orch02", "nas"];
  const i = order.indexOf(hostId);
  return i === -1 ? 99 : i;
}

/** Leave headroom — model file size is not the whole runtime footprint (KV cache etc). */
const HEADROOM = 0.85;

export function route(task: TaskClass, opts: RouteOpts = {}): RouteResult {
  const {
    needsTools = task === "agentic",
    sparePriorityHost = true,
    pinHost,
    ignoreHealth = false,
  } = opts;

  const eligible = (m: FleetModel, h: FleetHost): boolean => {
    if (pinHost && h.id !== pinHost) return false;
    if (m.sizeGB > h.maxModelGB * HEADROOM) return false;
    // NAS runs Aria production + Frigate: embeddings only, unless explicitly allowed.
    if (sparePriorityHost && h.id === "nas" && task !== "embed") return false;
    if (!ignoreHealth && unhealthy.has(h.id)) return false;
    return true;
  };

  type Cand = { m: FleetModel; h: FleetHost };
  const cands: Cand[] = [];
  // For agentic work require PROVEN structured tool_calls, not the advertised
  // capability — qwen2.5-coder:32b advertises tools and returns the call as plain
  // text, which silently breaks any tool loop.
  const toolOk = (m: FleetModel) =>
    !needsTools || (task === "agentic" ? m.toolsVerified === true : m.tools);

  for (const m of MODELS) {
    if (!m.good.includes(task)) continue;
    if (!toolOk(m)) continue;
    for (const hid of m.hosts) {
      const h = FLEET[hid];
      if (h && eligible(m, h)) cands.push({ m, h });
    }
  }

  // Widen: any tool-satisfying model anywhere, ignoring task fit.
  if (cands.length === 0) {
    for (const m of MODELS) {
      if (!toolOk(m)) continue;
      if (m.good.includes("embed") !== (task === "embed")) continue;
      for (const hid of m.hosts) {
        const h = FLEET[hid];
        if (h && eligible(m, h)) cands.push({ m, h });
      }
    }
    if (cands.length > 0) {
      cands.sort((a, b) => b.m.sizeGB - a.m.sizeGB);
      const w = cands[0];
      return {
        host: w.h,
        model: w.m.name,
        endpoint: w.h.endpoint,
        reason: `no exact match for task=${task}; widened to ${w.m.name} on ${w.h.id} (tools=${w.m.tools})`,
      };
    }
  }

  if (cands.length === 0) {
    // Hard fallback must still honour needsTools — the old code returned a fixed
    // model regardless, which would silently hand back a tool-less model.
    const h = FLEET.orch01;
    const model = needsTools ? "qwen3:30b-a3b" : "qwen2.5:32b";
    return {
      host: h,
      model,
      endpoint: h.endpoint,
      reason: `no candidate for task=${task} (needsTools=${needsTools}); hard fallback ${model} on orch01`,
    };
  }

  const heavy = task === "reason" || task === "code-review" || task === "agentic";
  cands.sort((a, b) => {
    const hr = hostRank(task, a.h.id) - hostRank(task, b.h.id);
    if (hr !== 0) return hr;
    // heavy: biggest capable model. light: smallest sufficient, to stay fast.
    return heavy ? b.m.sizeGB - a.m.sizeGB : a.m.sizeGB - b.m.sizeGB;
  });

  const best = cands[0];
  return {
    host: best.h,
    model: best.m.name,
    endpoint: best.h.endpoint,
    reason:
      `task=${task} -> ${best.m.name} (${best.m.sizeGB}GB, tools=${best.m.tools}) on ` +
      `${best.h.id} [${best.h.accel} ${best.h.accelMemGB}GB]; ` +
      (heavy ? "heavy: orch01 + largest capable" : "light: orch02 preferred, smallest sufficient") +
      (sparePriorityHost ? "; NAS reserved for embeddings (Aria production)" : "") +
      (unhealthy.size ? `; unhealthy=[${[...unhealthy].join(",")}]` : ""),
  };
}

/** Human-readable capacity summary. */
export function fleetSummary(): string {
  return Object.values(FLEET)
    .map(
      (h) =>
        `${h.id.padEnd(7)} ${h.endpoint.padEnd(28)} ${h.accel.padEnd(10)} ` +
        `${String(h.accelMemGB).padStart(3)}GB accel / ${String(h.ramGB).padStart(3)}GB RAM  ` +
        `max~${h.maxModelGB}GB${h.sharedWith ? `  [shared: ${h.sharedWith}]` : ""}`,
    )
    .join("\n");
}
