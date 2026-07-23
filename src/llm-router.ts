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

interface Producer { vesselId: string; endpoint: string; resolveUrl: string; }
interface Arm { alpha: number; beta: number; }

// ── discovery of llm_completion producers (short TTL cache) ──────────────────
// llm_completion producers are resolved through discovery per call (30s TTL) and the forward target is built live from the fresh discovery row's libp2p_multiaddr, so a hub restart never requires a spoke edit.
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
    const fedEgress = process.env["FED_TRANSPORT_EGRESS"] ?? "http://127.0.0.1:8401"; // Egress target is the fresh discovery libp2p_multiaddr[0] resolved per call
    const preferLibp2p = process.env["PREFER_LIBP2P_ROUTE"] === "1";
    const producers: Producer[] = vessels
      .map((v) => {
        const endpoint = String(v?.endpoint ?? "");
        const vid = String(v?.vesselId ?? v?.vessel_id ?? v?.id ?? "");
        const isLibp2p =
          (v.protocol === "libp2p" || preferLibp2p) &&
          Array.isArray(v.libp2p_multiaddr) &&
          typeof v.libp2p_multiaddr[0] === "string" &&
          (v.libp2p_multiaddr[0] as string).length > 0;
        if (isLibp2p) {
          const multiaddr = v.libp2p_multiaddr[0] as string;
          return {
            vesselId: vid,
            endpoint,
            resolveUrl:
              fedEgress +
              "/egress/resolve?target=" +
              encodeURIComponent(multiaddr) +
              "&vessel=" +
              encodeURIComponent(vid),
            _libp2p: true as const,
          };
        }
        return {
          vesselId: vid,
          endpoint,
          resolveUrl:
            typeof v.resolve_endpoint === "string" && v.resolve_endpoint.startsWith("http")
              ? v.resolve_endpoint
              : typeof v.resolve_endpoint === "string" && v.resolve_endpoint.length > 0
                ? endpoint.replace(/\/+$/, "") + "/" + v.resolve_endpoint.replace(/^\//, "")
                : endpoint + "/resolve",
          _libp2p: false as const,
        };
      })
      .filter((p) =>
        p.vesselId.length > 0 &&
        (p._libp2p
          ? true
          : /^https?:\/\//.test(p.endpoint))
      )
      .map((p): Producer => ({ vesselId: p.vesselId, endpoint: p.endpoint, resolveUrl: p.resolveUrl }));
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

async function postFeedback(vesselId: string | null, taskType: string, reached: boolean): Promise<void> {
  if (vesselId == null) return;
  try {
    await fetch(`${ACTIVITY_API_ENDPOINT.replace(/\/$/, "")}/v2/llm-router/feedback`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ task_type: taskType, vessel_id: vesselId, reached, latency_ms: 0, cost_usd: 0 }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* fire-and-forget */ }
}

async function routeOverRanked(
  ranked: Array<{ resolveUrl: string; vesselId: string | null }>,
  dispatchId: string,
  taskType: string,
  body: { prompt: string; maxTokens?: number; system?: string; model?: string },
): Promise<RoutedResult> {
  const payload: Record<string, unknown> = { type: "llm_completion", prompt: body.prompt, task_type: taskType };
  if (body.maxTokens) payload.max_tokens = body.maxTokens;
  if (body.system) payload.system = body.system;
  for (const sel of ranked.slice(0, 2)) {
    if (sel.vesselId === null && body.model) payload.model = body.model;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let r: Response;
      try {
        r = await fetch(sel.resolveUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) {
        await postFeedback(sel.vesselId, taskType, false);
        continue;
      }
      const j = await r.json();
      const inner = (j && typeof j === "object" && (j as any).content && typeof (j as any).content === "object" && (((j as any).content as any).body !== undefined || ((j as any).content as any).shape !== undefined)) ? (j as any).content : j;
      const text: unknown = (inner as any)?.body?.content ?? (inner as any)?.content ?? (inner as any)?.body?.text ?? (inner as any)?.value ?? "";
      if (typeof text !== "string" || text === "") {
        await postFeedback(sel.vesselId, taskType, false);
        continue;
      }
      await postFeedback(sel.vesselId, taskType, true);
      if (sel.vesselId) buffer(dispatchId, { taskType, vesselId: sel.vesselId, latencyMs: 0, costUsd: 0 });
      return { ok: true, json: { ...(inner as any), body: { ...(((inner as any)?.body) ?? {}), content: text } }, vesselId: sel.vesselId };
    } catch {
      await postFeedback(sel.vesselId, taskType, false);
      continue;
    }
  }
  return { ok: false, json: null, vesselId: null };
}

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
  if (ROUTER_DISABLED) {
    const fb = fallbackSelection();
    if (!fb) return { ok: false, json: null, vesselId: null };
    return routeOverRanked([fb], dispatchId, taskType, body);
  }
  const producers = await discoverProducers();
  if (producers.length === 0) {
    const fb = fallbackSelection();
    if (!fb) return { ok: false, json: null, vesselId: null };
    return routeOverRanked([fb], dispatchId, taskType, body);
  }
  const arms = await fetchArms(taskType);
  const scored = producers.map((p) => {
    const arm = arms.get(p.vesselId);
    return { sel: { resolveUrl: p.resolveUrl, vesselId: p.vesselId }, score: sampleBeta(arm?.alpha ?? 1, arm?.beta ?? 1) };
  });
  scored.sort((a, b) => b.score - a.score);

  // --- Routed path: dispatch to the Thompson-sampled winning vessel ---
  const winner = scored[0]?.sel ?? null;
  if (winner) {
    const selectedEndpoint = winner.resolveUrl;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let r: Response;
      try {
        r = await fetch(selectedEndpoint, {
          method: "POST",
          headers: authHeaders(),
          // No model override — the vessel's own pinned default applies.
          body: JSON.stringify({ type: "llm_completion", prompt: body.prompt, ...(body.maxTokens ? { max_tokens: body.maxTokens } : {}), ...(body.system ? { system: body.system } : {}), task_type: taskType }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (r.ok) {
        const j: any = await r.json();
        const inner = (j && typeof j === "object" && (j as any).content && typeof (j as any).content === "object" && ((((j as any).content as any).body !== undefined) || (((j as any).content as any).shape !== undefined))) ? (j as any).content : j;
        const text: unknown = (inner as any)?.body?.content ?? (inner as any)?.content ?? (inner as any)?.body?.text ?? (inner as any)?.value ?? "";
        if (typeof text === "string" && text.length > 0) {
          await postFeedback(winner.vesselId, taskType, true);
          buffer(dispatchId, { taskType, vesselId: winner.vesselId, latencyMs: 0, costUsd: 0 });
          return { ok: true, json: { ...(inner as any), body: { ...((inner as any)?.body ?? {}), content: text } }, vesselId: winner.vesselId };
        }
      }
      await postFeedback(winner.vesselId, taskType, false);
    } catch {
      await postFeedback(winner.vesselId, taskType, false);
    }
    // --- Fallback path (routed vessel failed): cascade through the OTHER ranked
    // producers (including federated hub arms reached via egress) BEFORE the single
    // env fallback, instead of jumping straight to a possibly-dead
    // LLM_VESSEL_ENDPOINT. This is what stops the reach verifier / inference from
    // fail-closing when the local Thompson-winner arm is credit-dead but a
    // quota-having in-identity-group arm exists. ---
    const rest = scored.slice(1).map((s) => s.sel);
    const fb = fallbackSelection();
    const cascade = fb ? [...rest, fb] : rest;
    if (cascade.length === 0) return { ok: false, json: null, vesselId: null };
    return routeOverRanked(cascade, dispatchId, taskType, body);
  }

  const ranked = scored.map((s) => s.sel);
  return routeOverRanked(ranked, dispatchId, taskType, body);
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
  const text = j?.body?.content ?? j?.content ?? j?.body?.text ?? j?.value ?? "";
  return typeof text === "string" && text.length > 0 ? text : null;
}

/** Envelope-safe unwrap of a RAW llm_completion_dispatch / hub-proxied response.
 *  Handles the federated proxy envelope {content:{shape,value}} identically to the
 *  inline unwrap in routedComplete (llm-router.ts:305-306). Returns "" for any
 *  non-string / empty payload — never fabricates. Use at every raw fetch of an LLM
 *  completion in goal-host so no spoke->hub answer is silently dropped. */
export function unwrapLlmContent(j: any): string {
  const inner = (j && typeof j === "object" && j.content && typeof j.content === "object" && (j.content.body !== undefined || j.content.shape !== undefined)) ? j.content : j;
  const text: unknown = inner?.body?.content ?? inner?.content ?? inner?.body?.text ?? inner?.value ?? "";
  return typeof text === "string" ? text : "";
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
