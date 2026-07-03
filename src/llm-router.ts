// llm-router.ts — per-task-type LLM routing over the discovery-advertised
// llm_completion producers, learned via activity-api's llm_router_decisions cell.
//
// WHY: goal-host makes several distinct kinds of internal LLM reasoning call
// (goal_target_inference, reach_verification, action_shape_selection, …). Each
// historically hardcoded a single model. This router instead treats every
// llm-resolver VESSEL as a learnable arm (vessel_id == pinned model) and picks,
// PER TASK TYPE, via Thompson sampling of the arm's Beta(α,β). The arm is
// rewarded by the dispatch's final `reached` verdict (α on reach, β on hollow).
//
// SELECTION: discover llm_completion producers → for each, sample Beta(α,β)
// (missing arm ⇒ uniform Beta(1,1) prior ⇒ explored on equal footing) → route to
// the argmax vessel with NO model override, so the vessel's own pinned default
// applies. That is what makes vessel_id the thing we learn over.
//
// FAIL-OPEN: if discovery has no producer, or activity-api is unreachable, or
// LLM_ROUTER_DISABLED=1, we fall back to the single LLM_VESSEL_ENDPOINT and honor
// the caller's hardcoded model — reproducing exactly the pre-router behavior.
//
// REWARD ATTRIBUTION: routed selections are buffered per dispatch (keyed by the
// caller's dispatchId, in practice goalHashOf(goal)). flushRouterFeedback(id,
// reached) is called once at the dispatch's terminal point (runGoalWithRecovery
// return) and posts one Beta update per buffered selection, then clears the
// buffer. Concurrent dispatches of the *same* goal string share a buffer — a
// small, self-correcting source of reward noise, not a correctness bug.

// The llm_router_decisions cell is LOCAL substrate state (which local llm vessel
// to pick), distinct from the trace/template learning surface — which under the
// federation drop-in may point at a remote hub (ACTIVITY_API_ENDPOINT). So the
// router's learning endpoint resolves to the LOCAL activity-api, not the hub:
// PRODUCER_DISCOVERY_ENDPOINT is already the local one; override with
// LLM_ROUTER_API_ENDPOINT if needed.
const ACTIVITY_API_ENDPOINT =
  process.env.LLM_ROUTER_API_ENDPOINT ??
  process.env.PRODUCER_DISCOVERY_ENDPOINT ??
  "http://127.0.0.1:8080";
const DISCOVERY_ENDPOINT = process.env.DISCOVERY_VESSEL_ENDPOINT ?? "http://127.0.0.1:8100";
const API_KEY = process.env.GOAL_HOST_VESSEL_API_KEY ?? process.env.METABOB_API_KEY ?? "";
const LLM_FALLBACK_ENDPOINT = process.env.LLM_VESSEL_ENDPOINT;
const ROUTER_DISABLED = process.env.LLM_ROUTER_DISABLED === "1";

const authHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}),
});

interface Producer { vesselId: string; endpoint: string; }
interface Arm { alpha: number; beta: number; }

// ── discovery of llm_completion producers (short TTL cache) ──────────────────
let producerCache: { at: number; producers: Producer[] } | null = null;
const PRODUCER_TTL_MS = 30_000;

async function discoverProducers(): Promise<Producer[]> {
  const now = Date.now();
  if (producerCache && now - producerCache.at < PRODUCER_TTL_MS) return producerCache.producers;
  try {
    const r = await fetch(`${DISCOVERY_ENDPOINT.replace(/\/$/, "")}/resolve`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "llm_completion" } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return producerCache?.producers ?? [];
    const j: any = await r.json();
    const vessels: any[] = j?.content?.vessels ?? j?.vessels ?? [];
    const producers: Producer[] = vessels
      .map((v) => ({
        vesselId: String(v?.vesselId ?? v?.vessel_id ?? v?.id ?? ""),
        endpoint: String(v?.endpoint ?? ""),
      }))
      .filter((p) => p.vesselId.length > 0 && /^https?:\/\//.test(p.endpoint));
    producerCache = { at: now, producers };
    return producers;
  } catch {
    return producerCache?.producers ?? [];
  }
}

// ── per-arm Beta stats for a task type ───────────────────────────────────────
async function fetchArms(taskType: string): Promise<Map<string, Arm>> {
  const arms = new Map<string, Arm>();
  try {
    const r = await fetch(
      `${ACTIVITY_API_ENDPOINT.replace(/\/$/, "")}/v2/llm-router/candidates?task_type=${encodeURIComponent(taskType)}`,
      { method: "GET", headers: authHeaders(), signal: AbortSignal.timeout(5_000) },
    );
    if (!r.ok) return arms;
    const j: any = await r.json();
    for (const c of (j?.candidates ?? []) as any[]) {
      if (typeof c?.vessel_id === "string") {
        arms.set(c.vessel_id, {
          alpha: typeof c.alpha === "number" && c.alpha >= 1 ? c.alpha : 1,
          beta: typeof c.beta === "number" && c.beta >= 1 ? c.beta : 1,
        });
      }
    }
  } catch { /* fail soft ⇒ all arms read as the uniform prior */ }
  return arms;
}

// ── Beta sampler (Marsaglia–Tsang gamma; valid for shape ≥ 1, always true here
//    since α,β start at 1 and only increment) ────────────────────────────────
function sampleNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function sampleGamma(shape: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, vv: number;
    do { x = sampleNormal(); vv = 1 + c * x; } while (vv <= 0);
    vv = vv * vv * vv;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * vv;
    if (Math.log(u) < 0.5 * x * x + d * (1 - vv + Math.log(vv))) return d * vv;
  }
}
function sampleBeta(alpha: number, beta: number): number {
  const ga = sampleGamma(Math.max(1, alpha));
  const gb = sampleGamma(Math.max(1, beta));
  return ga / (ga + gb);
}

// ── selection ────────────────────────────────────────────────────────────────
interface Selection { resolveUrl: string; vesselId: string | null; }

function fallbackSelection(): Selection | null {
  if (!LLM_FALLBACK_ENDPOINT) return null;
  return { resolveUrl: `${LLM_FALLBACK_ENDPOINT.replace(/\/$/, "")}/resolve`, vesselId: null };
}

async function selectForTaskType(taskType: string): Promise<Selection | null> {
  if (ROUTER_DISABLED) return fallbackSelection();
  const producers = await discoverProducers();
  if (producers.length === 0) return fallbackSelection();
  const arms = await fetchArms(taskType);
  let best: Producer | null = null;
  let bestScore = -1;
  for (const p of producers) {
    const arm = arms.get(p.vesselId);
    const score = sampleBeta(arm?.alpha ?? 1, arm?.beta ?? 1);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (!best) return fallbackSelection();
  return { resolveUrl: `${best.endpoint.replace(/\/$/, "")}/resolve`, vesselId: best.vesselId };
}

// ── per-dispatch reward buffer ───────────────────────────────────────────────
interface BufferedSelection { taskType: string; vesselId: string; latencyMs: number; costUsd: number; }
const buffers = new Map<string, BufferedSelection[]>();
const MAX_BUFFERS = 512; // backstop against a dispatch that never flushes

function buffer(dispatchId: string, sel: BufferedSelection): void {
  if (!dispatchId) return;
  if (!buffers.has(dispatchId)) {
    if (buffers.size >= MAX_BUFFERS) {
      const oldest = buffers.keys().next().value;
      if (oldest !== undefined) buffers.delete(oldest);
    }
    buffers.set(dispatchId, []);
  }
  buffers.get(dispatchId)!.push(sel);
}

// ── the routed call — a drop-in for the old fetch(LLM_VESSEL_ENDPOINT/resolve) ─
export interface RoutedResult { ok: boolean; json: any; vesselId: string | null; }

/**
 * Route one llm_completion for a task type. `body.model` is applied ONLY on the
 * fallback path (single-endpoint, vessel_id null) to preserve pre-router
 * behavior; when a real producer is selected, NO model override is sent so the
 * vessel's pinned default (the learned arm) applies. The selection is buffered
 * under dispatchId for end-of-dispatch reward.
 */
export async function routedComplete(
  dispatchId: string,
  taskType: string,
  body: { prompt: string; maxTokens?: number; system?: string; model?: string },
): Promise<RoutedResult> {
  const sel = await selectForTaskType(taskType);
  if (!sel) return { ok: false, json: null, vesselId: null };
  const payload: Record<string, unknown> = { type: "llm_completion", prompt: body.prompt };
  if (body.maxTokens) payload.max_tokens = body.maxTokens;
  if (body.system) payload.system = body.system;
  if (sel.vesselId === null && body.model) payload.model = body.model; // fallback only
  const t0 = Date.now();
  try {
    const r = await fetch(sel.resolveUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    const latencyMs = Date.now() - t0;
    if (sel.vesselId) buffer(dispatchId, { taskType, vesselId: sel.vesselId, latencyMs, costUsd: 0 });
    if (!r.ok) return { ok: false, json: null, vesselId: sel.vesselId };
    const j = await r.json();
    return { ok: true, json: j, vesselId: sel.vesselId };
  } catch {
    const latencyMs = Date.now() - t0;
    if (sel.vesselId) buffer(dispatchId, { taskType, vesselId: sel.vesselId, latencyMs, costUsd: 0 });
    return { ok: false, json: null, vesselId: sel.vesselId };
  }
}

/** Convenience wrapper returning just the completion text (or null). */
export async function routedText(
  dispatchId: string,
  taskType: string,
  prompt: string,
  opts?: { maxTokens?: number; system?: string; model?: string },
): Promise<string | null> {
  const rr = await routedComplete(dispatchId, taskType, { prompt, ...(opts ?? {}) });
  if (!rr.ok) return null;
  const j = rr.json;
  const text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
  return typeof text === "string" && text.length > 0 ? text : null;
}

/**
 * Post one Beta update per buffered selection for this dispatch, then clear the
 * buffer. Called once at the dispatch's terminal point with the final reach
 * verdict. Fire-and-forget: learning writes never block or fail the dispatch.
 */
export async function flushRouterFeedback(dispatchId: string, reached: boolean): Promise<void> {
  const buf = buffers.get(dispatchId);
  if (!buf) return;
  buffers.delete(dispatchId);
  await Promise.allSettled(
    buf.map((s) =>
      fetch(`${ACTIVITY_API_ENDPOINT.replace(/\/$/, "")}/v2/llm-router/feedback`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          task_type: s.taskType,
          vessel_id: s.vesselId,
          reached,
          latency_ms: s.latencyMs,
          cost_usd: s.costUsd,
        }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined),
    ),
  );
}
