/**
 * goal-host-vessel — wraps GoalHost in a substrate HTTP vessel (port 8210).
 *
 * Spec: openspec/changes/2026-05-23-substrate-explicit-vessels Phase 4, tasks 4.1–4.2.
 *
 * Exposes:
 *   POST /run-goal   — { goal, targetTemplateId?, variables?, parent_execution_id?, composition_chain? }
 *   POST /resolve    — { type: "goal_execution" | "activity_execution", goal, ... }
 *   GET  /health     — liveness probe
 *
 * Discovery advertisement: goal_execution, activity_execution shapes.
 * auth_token_source: caller_identity; resolve_timeout_ms: 60000.
 *
 * LLM routing:
 *   - When LLM_VESSEL_ENDPOINT is set (e.g. http://127.0.0.1:8220): HttpLLMPort.
 *   - Otherwise: InProcessLLMPort wrapping the Anthropic SDK (requires ANTHROPIC_API_KEY).
 */

import { repairSignatureOf, classifyFailure } from './repair-signature';
import { appendFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { inferGoalTargetShapes, inferDerivationSplit, goalHashOf } from "./goal-target-inference";
import { orderRing } from "./mem-ring";
import {
  GoalHost,
  DiscoveryRegistrationLoop,
  createLLMPort,
  ActivityApiAdapter,
} from "@avigopal/ias-executor-ts";
import { BusForwardingEventSink, TranslatingTraceSink } from "@avigopal/ias-executor-ts/adapters";
import type {
  EventSink,
  Impulse,
  ActivityTemplate,
  ExecutionTrace,
} from "@avigopal/ias-executor-ts";

// ─────────────────────────────────────────────────────────────────────────────
// BoundedBusSink — L1 patch per openspec 2026-05-31-goal-host-oom-bounded-concurrency.
//
// Wraps BusForwardingEventSink (whose forward() is fire-and-forget `void (async
// () => { await fetch(...) })()`). Each unawaited Promise retains the event
// body string in memory until the HTTP POST resolves. When activity-api is slow
// or the engine emits hundreds of events per execution, in-flight Promises
// accumulate unboundedly — the observed cascade: ~10 GB RSS in ~3 minutes,
// repeated SIGKILL by systemd.
//
// This wrapper enforces:
//   - In-memory FIFO queue capped at QUEUE_MAX (100). Drop-oldest at overflow.
//   - Worker drain capped at MAX_INFLIGHT (default 32, env BUS_MAX_INFLIGHT).
//   - Total in-flight body bytes capped at MAX_INFLIGHT_BYTES (default 50 MB,
//     env BUS_MAX_INFLIGHT_BYTES). Events skipped when over the cap.
//   - Periodic stats line every 30 s: in_flight, dropped_since_last, bytes.
//   - Drops never throw; logged only. The inner sink is still called
//     synchronously on every emit so in-process subscribers are unaffected.
//
// Doubles as Phase 2 instrumentation: the stats line lets us observe whether
// in_flight grows monotonically (confirming hypothesis #1) or plateaus
// (backpressure working).
// ─────────────────────────────────────────────────────────────────────────────

const BUS_MAX_INFLIGHT = parseInt(
  process.env.IAS_BUS_MAX_INFLIGHT ?? process.env.BUS_MAX_INFLIGHT ?? "256",
  10,
);
const BUS_MAX_INFLIGHT_BYTES = parseInt(
  process.env.BUS_MAX_INFLIGHT_BYTES ?? String(50 * 1024 * 1024),
  10,
);
const BUS_QUEUE_MAX = parseInt(
  process.env.IAS_BUS_QUEUE_SIZE ?? process.env.BUS_QUEUE_MAX ?? "1024",
  10,
);
const BUS_STATS_INTERVAL_MS = 30_000;
// When backpressure exceeds this window, fall through to drop+signal. Bounded
// to keep callers from hanging indefinitely if activity-api is wedged.
const BUS_BACKPRESSURE_MAX_WAIT_MS = parseInt(
  process.env.IAS_BUS_BACKPRESSURE_MAX_WAIT_MS ?? "30000",
  10,
);
const DISPATCH_DROP_LOG_PATH =
  process.env.IAS_BUS_DROP_LOG_PATH ?? "/workspace/dispatch-dropped.jsonl";

// Env-defaulted endpoint for goal-host-vessel's own /run-goal route.
// Override with GOAL_HOST_VESSEL_ENDPOINT to avoid hardcoded host:port drift.
const GOAL_HOST_ENDPOINT =
  process.env.GOAL_HOST_VESSEL_ENDPOINT ?? "http://127.0.0.1:8210"
const FED_TRANSPORT_EGRESS = process.env.FED_TRANSPORT_EGRESS ?? "http://127.0.0.1:8401";

/**
 * Resolve the HTTP endpoint to use for a discovered vessel record.
 * When discoveredVia === 'peer', the vessel lives on a remote substrate;
 * route through peerEndpoint (the peer discovery URL) so the request
 * reaches the correct substrate boundary. Also returns resolved_by_vessel_id
 * for provenance capture on execution traces.
 */
function endpointForShape(
  v: Record<string, unknown>,
): { endpoint: string; resolvedByVesselId?: string } {
  if (v.discoveredVia === "peer" && typeof v.peerEndpoint === "string" && v.peerEndpoint) {
    return {
      endpoint: v.peerEndpoint,
      resolvedByVesselId: typeof v.vesselId === "string" ? v.vesselId : undefined,
    }
  }
  return {
    endpoint: typeof v.endpoint === "string" ? v.endpoint : "",
    resolvedByVesselId: undefined,
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// L2 instrumentation — process.memoryUsage() trajectory probe
//
// Hypothesis #1 (Promise queue in BusForwardingEventSink) was REFUTED by L1
// stats showing in_flight=0 across the pre-OOM window while RSS grew 0→10 GB.
// Signature is event-loop starvation (stats stopped at ~1.6 GB).
//
// This module:
//   - Captures process.memoryUsage() into a circular ring (MEM_RING_SIZE=512)
//   - Records on every WS message arrival (cheapest signal density), every
//     BoundedBusSink emit, and at a 5s interval
//   - Dumps ring → /workspace/.goal-host-mem-dump.json every 5s (survives OOM)
//   - Re-dumps + flushes on SIGTERM (so post-mortem catches the last moments
//     before systemd's SIGKILL escalation)
//
// What each region tells us:
//   - heapUsed grows: JS object retention (listener closures, parsed event objs)
//   - external grows: C++-backed Buffers / WS frames not released
//   - arrayBuffers grows: raw byte arrays (likely WS frame payloads)
//   - rss grows but heap/external/arrayBuffers flat: V8 fragmentation / native
//     allocator (less likely under Bun)
// ─────────────────────────────────────────────────────────────────────────────

const MEM_RING_SIZE = 512;
const MEM_DUMP_PATH = process.env.MEM_DUMP_PATH ?? "/workspace/.goal-host-mem-dump.json";
const MEM_DUMP_INTERVAL_MS = 5_000;

interface MemSample {
  t: number;             // ms since epoch
  source: string;        // "ws" | "bus" | "tick"
  msgSize?: number;      // bytes of triggering WS payload, if any
  msgType?: string;      // type field of WS event, if any
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

const memRing: MemSample[] = [];
let memRingHead = 0;
let biggestMsg: { size: number; type: string; at: number } = { size: 0, type: "", at: 0 };

function recordMemSample(source: string, msgSize?: number, msgType?: string): void {
  const mu = process.memoryUsage();
  const sample: MemSample = {
    t: Date.now(),
    source,
    msgSize,
    msgType,
    rss: mu.rss,
    heapUsed: mu.heapUsed,
    heapTotal: mu.heapTotal,
    external: mu.external,
    arrayBuffers: mu.arrayBuffers,
  };
  if (memRing.length < MEM_RING_SIZE) {
    memRing.push(sample);
  } else {
    memRing[memRingHead] = sample;
    memRingHead = (memRingHead + 1) % MEM_RING_SIZE;
  }
  if (msgSize !== undefined && msgSize > biggestMsg.size) {
    biggestMsg = { size: msgSize, type: msgType ?? "?", at: sample.t };
  }
}

async function flushMemDump(reason: string): Promise<void> {
  try {
    // Order ring oldest-first when wrapped.
    const ordered = orderRing(memRing, memRingHead, MEM_RING_SIZE);
    const payload = {
      generated_at: new Date().toISOString(),
      reason,
      pid: process.pid,
      uptime_s: process.uptime(),
      samples: ordered,
      biggest_msg: biggestMsg,
      env: {
        BUS_MAX_INFLIGHT,
        BUS_MAX_INFLIGHT_BYTES,
      },
    };
    await Bun.write(MEM_DUMP_PATH, JSON.stringify(payload));
  } catch (err) {
    // Never let dump failures kill the process — they're observability, not load-bearing.
    console.warn(`[mem-probe] dump failed: ${(err as Error).message}`);
  }
}

setInterval(() => {
  recordMemSample("tick");
  void flushMemDump("interval");
}, MEM_DUMP_INTERVAL_MS).unref();

setInterval(() => {
  const mu = process.memoryUsage();
  console.log(
    `[mem-probe] rss=${(mu.rss / 1024 / 1024).toFixed(1)}MB ` +
      `heapUsed=${(mu.heapUsed / 1024 / 1024).toFixed(1)}MB ` +
      `external=${(mu.external / 1024 / 1024).toFixed(1)}MB ` +
      `arrayBuffers=${(mu.arrayBuffers / 1024 / 1024).toFixed(1)}MB ` +
      `biggest_msg=${(biggestMsg.size / 1024).toFixed(1)}KB(${biggestMsg.type})`,
  );
}, BUS_STATS_INTERVAL_MS).unref();

process.on("SIGTERM", () => { void flushMemDump("SIGTERM"); });
process.on("SIGINT", () => { void flushMemDump("SIGINT"); });

// ─────────────────────────────────────────────────────────────────────────────
// Iteration 6 of the OOM hunt — periodic Bun.gc(true) workaround.
//
// Per iteration-5 findings (see concept_s9ye5GKLw2L8 / concept_T-CTTOEl97IM):
// goal-host RSS grew 16.6 → 18.4 GB in 60s of IDLE time (boredom timer
// inactive, no inbound requests). Map count slightly DECREASED while RSS
// increased. This signature is heap-arena retention by Bun's native allocator
// — memory is freed at the JS level but not released back to the OS until a
// full GC + arena trim runs.
//
// process.memoryUsage().heapUsed stayed at ~2 MB throughout (V8/JSC's
// accounting doesn't see arena retention). The cause survived all of:
//   - BoundedBusSink bus-path backpressure (iter 1)
//   - WS message buffer audit (iter 2)
//   - Response.body drain across 11 fetch sites (iter 3)
//   - AbortSignal.timeout → manual AbortController + clearTimeout (iter 4)
//   - BunProcessAdapter pipe FD investigation (iter 5 — refuted by location)
//
// Pragmatic workaround: force a full GC every 30s. Bun.gc(true) performs
// generational + major mark-sweep AND releases freed allocator pages back to
// the OS. If the leak is heap-arena retention, this bounds RSS.
//
// This is a workaround, not a root-cause fix. The underlying issue is in
// Bun 1.3.14's native allocator behavior under high-frequency idle-time
// fetch/WS load. A proper fix requires either upstream Bun work OR
// identifying the specific allocation site through per-fetch instrumentation
// (deferred to iter 7 once substrate is stable enough to probe).
//
// .unref() so this timer doesn't prevent process exit.
// ─────────────────────────────────────────────────────────────────────────────
// Iteration 7 instrumentation — per-fetch RSS delta probe.
//
// If iter-6's Bun.gc(true) workaround doesn't bound RSS, this gives us the
// exact leaking fetch site. Wraps globalThis.fetch with a labeled probe that
// records pre/post process.memoryUsage().rss per call. Aggregates by label
// over a 60s window, dumped to /workspace/.fetch-trace.json on every gc tick.
//
// The label is passed via an `x-fetch-label` header that THIS wrapper strips
// before calling the real fetch. Existing fetch sites unchanged; new sites
// can pass the label to attribute their leak. Sites that don't pass a label
// get attributed to their request URL host.
//
// Gated on env GOAL_HOST_FETCH_PROBE=1 so it's opt-in (the probe itself adds
// overhead). Default OFF; enable when iter-6's GC workaround fails the
// 30-min observation.
const FETCH_PROBE_ENABLED = process.env.GOAL_HOST_FETCH_PROBE === "1";
interface FetchProbeStats {
  count: number;
  total_rss_delta: number;
  max_rss_delta: number;
  total_duration_ms: number;
}
const fetchProbeStats = new Map<string, FetchProbeStats>();
if (FETCH_PROBE_ENABLED) {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let label: string | undefined;
    let cleanInit = init;
    if (init?.headers) {
      const headers = new Headers(init.headers);
      const labelValue = headers.get("x-fetch-label");
      if (labelValue) {
        label = labelValue;
        headers.delete("x-fetch-label");
        cleanInit = { ...init, headers };
      }
    }
    if (!label) {
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        label = `auto:${new URL(url).host}`;
      } catch {
        label = "auto:unknown";
      }
    }
    const rssBefore = process.memoryUsage().rss;
    const t0 = performance.now();
    try {
      return await realFetch(input, cleanInit);
    } finally {
      const rssAfter = process.memoryUsage().rss;
      const duration = performance.now() - t0;
      const delta = rssAfter - rssBefore;
      const cur = fetchProbeStats.get(label) ?? {
        count: 0, total_rss_delta: 0, max_rss_delta: 0, total_duration_ms: 0,
      };
      cur.count += 1;
      cur.total_rss_delta += delta;
      cur.max_rss_delta = Math.max(cur.max_rss_delta, delta);
      cur.total_duration_ms += duration;
      fetchProbeStats.set(label, cur);
      // v2 mitosis: bound the per-label map to prevent unbounded URL growth.
      if (fetchProbeStats.size > 50) {
        const keys = Array.from(fetchProbeStats.keys());
        for (let i = 0; i < 20 && i < keys.length; i++) {
          fetchProbeStats.delete(keys[i]);
        }
      }
    }
  }) as typeof globalThis.fetch;
  console.log("[fetch-probe] instrumented globalThis.fetch (label via x-fetch-label header)");
}

function flushFetchProbeStats(): void {
  if (!FETCH_PROBE_ENABLED || fetchProbeStats.size === 0) return;
  const entries = Array.from(fetchProbeStats.entries())
    .map(([label, s]) => ({
      label,
      count: s.count,
      total_rss_delta_mb: +(s.total_rss_delta / 1024 / 1024).toFixed(2),
      max_rss_delta_mb: +(s.max_rss_delta / 1024 / 1024).toFixed(2),
      mean_rss_delta_kb: +(s.total_rss_delta / s.count / 1024).toFixed(1),
      mean_duration_ms: +(s.total_duration_ms / s.count).toFixed(1),
    }))
    .sort((a, b) => b.total_rss_delta_mb - a.total_rss_delta_mb);
  console.log(`[fetch-probe] ${JSON.stringify(entries.slice(0, 10))}`);
  fetchProbeStats.clear();
}

const GC_INTERVAL_MS = parseInt(process.env.GOAL_HOST_GC_INTERVAL_MS ?? "30000", 10);
interface BunGlobal { Bun?: { gc?: (force: boolean) => number } }
const bunGlobal = globalThis as unknown as BunGlobal;
setInterval(() => {
  const gc = bunGlobal.Bun?.gc;
  if (typeof gc === "function") {
    try {
      const freed = gc(true);
      const rssMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      console.log(`[gc-tick] freed=${freed}B rss_after=${rssMB}MB`);
    } catch (err) {
      console.warn(`[gc-tick] Bun.gc failed: ${(err as Error).message}`);
    }
  }
  flushFetchProbeStats();
}, GC_INTERVAL_MS).unref();

class BoundedBusSink implements EventSink {
  private readonly inner: BusForwardingEventSink;
  private readonly queue: Array<{ event: unknown; bytes: number }> = [];
  private readonly waiters: Array<() => void> = [];
  private inFlight = 0;
  private bytesInFlight = 0;
  private droppedSinceLastStats = 0;
  private droppedQueueOverflow = 0;
  private droppedByteCap = 0;
  private droppedTimeout = 0;
  private dispatchSeq = 0;

  constructor(opts: { inner: BusForwardingEventSink }) {
    this.inner = opts.inner;
    setInterval(() => this.emitStats(), BUS_STATS_INTERVAL_MS).unref();
  }

  emit(event: unknown): void | Promise<void> {
    let bytes = 0;
    try {
      bytes = JSON.stringify(event).length;
    } catch {
      bytes = 0;
    }
    if (this.queue.length < BUS_QUEUE_MAX) {
      this.queue.push({ event, bytes });
      this.drain();
      return;
    }
    // Queue full — apply backpressure: caller awaits until a slot frees up.
    // Cap the wait at BUS_BACKPRESSURE_MAX_WAIT_MS to avoid hanging callers
    // when activity-api is wedged; beyond that, drop + emit observable signal.
    return this.awaitCapacityThenEnqueue({ event, bytes });
  }

  private async awaitCapacityThenEnqueue(item: {
    event: unknown;
    bytes: number;
  }): Promise<void> {
    const waited = await this.waitForSlot();
    if (!waited) {
      this.droppedTimeout += 1;
      this.droppedSinceLastStats += 1;
      this.recordDispatchDropped("timeout_exceeded", item);
      return;
    }
    if (this.queue.length >= BUS_QUEUE_MAX) {
      // Still full after wake — drop oldest (preserve newer signal).
      this.queue.shift();
      this.droppedQueueOverflow += 1;
      this.droppedSinceLastStats += 1;
      this.recordDispatchDropped("queue_overflow", item);
    }
    this.queue.push(item);
    this.drain();
  }

  private waitForSlot(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.waiters.indexOf(wake);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(false);
      }, BUS_BACKPRESSURE_MAX_WAIT_MS);
      this.waiters.push(wake);
    });
  }

  private notifyWaiter(): void {
    const wake = this.waiters.shift();
    if (wake) wake();
  }

  private recordDispatchDropped(
    reason: "queue_overflow" | "byte_overflow" | "timeout_exceeded",
    _item: { event: unknown; bytes: number },
  ): void {
    const entry = {
      dispatch_id: `dispatch-drop-${Date.now()}-${++this.dispatchSeq}`,
      dropped_at: new Date().toISOString(),
      reason,
      queue_state: {
        in_flight: this.inFlight,
        queue: this.queue.length,
        bytes_in_flight: this.bytesInFlight,
      },
    };
    // Fire-and-forget; never throw. JSONL line per drop.
    appendFile(DISPATCH_DROP_LOG_PATH, JSON.stringify(entry) + "\n").catch(
      () => {},
    );
  }

  private drain(): void {
    while (
      this.queue.length > 0 &&
      this.inFlight < BUS_MAX_INFLIGHT &&
      this.bytesInFlight < BUS_MAX_INFLIGHT_BYTES
    ) {
      const item = this.queue.shift();
      if (!item) break;
      // Skip if this single event would push us way over the byte cap and
      // we already have something in flight — let the queue clear first.
      if (this.bytesInFlight > 0 && this.bytesInFlight + item.bytes > BUS_MAX_INFLIGHT_BYTES) {
        this.droppedByteCap += 1;
        this.droppedSinceLastStats += 1;
        this.recordDispatchDropped("byte_overflow", item);
        continue;
      }
      this.inFlight += 1;
      this.bytesInFlight += item.bytes;
      void this.forwardOne(item);
    }
  }

  private async forwardOne(item: { event: unknown; bytes: number }): Promise<void> {
    try {
      // Reuse the inner sink's emit() — it does inner-noop + fire-and-forget
      // forward. We are calling it ONE event at a time, paced by our gate.
      // Because BusForwardingEventSink.forward() is itself void-async, we
      // await a setTimeout to give it a chance to complete the fetch before
      // we release our slot. We use a probe: call emit, then wait the
      // publishTimeoutMs (default 2s) before decrementing. This is coarse
      // but safe — the goal is bounded concurrency, not precise tracking.
      const maybePromise = this.inner.emit(item.event as Parameters<EventSink["emit"]>[0]);
      if (maybePromise && typeof (maybePromise as Promise<void>).then === "function") {
        await maybePromise;
      }
      // Inner emit returns immediately after scheduling its fire-and-forget
      // forward. Wait the publish timeout window so the in-flight slot
      // actually models the HTTP work.
      await new Promise((r) => setTimeout(r, 2_500));
    } catch {
      // Inner emit shouldn't throw because its inner is noop and forward is
      // void; swallow defensively.
    } finally {
      this.inFlight -= 1;
      this.bytesInFlight -= item.bytes;
      if (this.bytesInFlight < 0) this.bytesInFlight = 0;
      // Pull more work in, then wake any backpressured caller waiting on a slot.
      this.drain();
      this.notifyWaiter();
    }
  }

  private emitStats(): void {
    console.log(
      `[BoundedBusSink] in_flight=${this.inFlight} queue=${this.queue.length} ` +
        `bytes_in_flight=${this.bytesInFlight} ` +
        `dropped_since_last=${this.droppedSinceLastStats} ` +
        `(overflow=${this.droppedQueueOverflow} byte_cap=${this.droppedByteCap} ` +
        `timeout=${this.droppedTimeout} waiters=${this.waiters.length})`,
    );
    this.droppedSinceLastStats = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8210", 10);
const VESSEL_ID = process.env.GOAL_HOST_VESSEL_ID ?? process.env.VESSEL_ID ?? "goal-host-vessel";
const ACTIVITY_API_ENDPOINT = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
// Producer discovery (the shape-walk's discover-by-shapes producer/candidate lookups)
// must query where the rich producer corpus LIVES — the LOCAL activity-api — not the
// federation hub (ACTIVITY_API_ENDPOINT), whose `activity` corpus declares almost no
// output_shapes → forward producer-discovery returns 0 → the walk takes 0 shape-feasible
// steps and hollow-completes. Trace-writes / feedback / recommend / Thompson stay on the
// hub (federation-wide credit). See 2026-07-01 producer-discovery split.
const PRODUCER_DISCOVERY_ENDPOINT = process.env.PRODUCER_DISCOVERY_ENDPOINT ?? "http://127.0.0.1:8080";
const DISCOVERY_ENDPOINT = process.env.DISCOVERY_VESSEL_ENDPOINT ?? "http://127.0.0.1:8100";
const DISCOVERY_SHAPES_ENDPOINT = `${DISCOVERY_ENDPOINT}/registry/shapes`;
const API_KEY = process.env.GOAL_HOST_VESSEL_API_KEY ?? process.env.METABOB_API_KEY ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const LLM_VESSEL_ENDPOINT = process.env.LLM_VESSEL_ENDPOINT;

const SHAPES = ["goal_execution", "activity_execution"] as const;
const VERSION = "0.1.0";
const DEV_VESSEL_ENDPOINT = process.env.DEVELOPMENT_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";

// Goal-reaching verification (2026-06-22). status=completed only means the
// selected template EXECUTED, not that the GOAL was reached — many completions
// are hollow (an unrelated wrapper runs and "succeeds"), which gives α-credit to
// goal-irrelevant templates and is WHY the substrate doesn't compose to reach
// goals. We judge reach against the goal via the LLM resolver (NOT a declared
// target shape — the operator's point: identify the shapes of the completion
// STATE, emergently). On not-reached we downgrade status to failed and β-penalise
// the selected template so Thompson stops reinforcing hollow completions.
interface GoalReachVerdict { reached: boolean; reason?: string; completion_shapes?: string[]; missing?: string[]; }
async function verifyGoalReached(goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string): Promise<GoalReachVerdict | null> {
  if (!LLM_VESSEL_ENDPOINT) return null;
  const prompt = `You verify whether a substrate execution REACHED its goal. status=completed does NOT mean reached — many executions "complete" by running unrelated activities (hollow completion).

GOAL: ${goal}

Produced output impulse shapes: ${JSON.stringify(producedShapes)}
Task summary: ${taskSummary}${contentDigest ? `\n\nProduced output CONTENT (truncated — judge reach from the ACTUAL content, not just shape names):\n${contentDigest}` : ""}

Judge by SUBSTANTIVE FULFILLMENT OF INTENT, not by verbatim text. The test is whether the produced output meaningfully accomplishes what the goal asked for. VERBATIM / EXACT-CHARACTER / EXACT-BYTE / EXACT-STRING equality is NOT required and MUST NOT be the basis for rejection: a goal that says 'write a note saying X' is REACHED by a note whose content conveys X, even if the wording, length, byte-count, or formatting differ from any literal text in the goal. Example: goal asks for a note with a 43-character phrase and the output is 40 bytes but conveys the same meaning → REACHED. Differences in length, punctuation, or phrasing are NOT grounds for hollow.

STILL score HOLLOW (reached:false) when the output genuinely fails the intent: nothing was produced; the WRONG shape was produced; the content is empty / 0-byte / a bare placeholder / a refusal or error envelope; or the output is MATERIALLY INCOMPLETE versus an explicitly multi-part goal (e.g. goal says move ALL inbox files but only one was moved; goal asks for problems WITH line numbers but the list is empty). A shape name alone is NOT evidence — when content is shown, judge the actual content, but judge it for MEANING, not literal match.

Then identify the shape(s) characterising the COMPLETION STATE of this goal-direction (a subset of produced shapes, and/or shapes that SHOULD exist at completion but do not yet).

Respond with ONLY JSON: {"reached": boolean, "reason": "<1 sentence>", "completion_shapes": ["<shape>"], "missing": ["<shape not produced but expected>"]}`;
  try {
    const r = await fetch(`${LLM_VESSEL_ENDPOINT.replace(/\/$/, "")}/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "llm_completion", prompt, model: "claude-haiku-4-5-20251001" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
    const m = String(text).match(/\{[\s\S]*\}/);
    return m ? (JSON.parse(m[0]) as GoalReachVerdict) : null;
  } catch { return null; }
}

// ── Goal→target-shape inference (lever 4, 2026-06-25) ───────────────────────
// inferGoalTargetShapes + goalHashOf live in ./goal-target-inference (extracted so
// they are unit-testable without booting this HTTP server). Below: the in-process
// goal_hash cache and the known-shape vocabulary fetch (which use this module's
// DISCOVERY_ENDPOINT / API_KEY and so stay here).
const inferredTargetShapeCache = new Map<string, string[]>();

// Known producible-shape vocabulary = discovery's advertised shapes (every shape
// has a live resolver, so the walk can reach it via backward-chain or mint-as-you-go).
// Cached briefly so we don't GET /registry/shapes on every fresh goal.
let knownShapesCache: { shapes: string[]; fetchedAt: number } | null = null;
const KNOWN_SHAPES_TTL_MS_UNUSED = 60_000;
// PEER SHAPE VOCABULARY (SC-P4 cross-location reach, 2026-07-02). Peer-federated
// capabilities (e.g. the operator-host obsidian vessel registered at the hub)
// are RESOLVABLE via discovery peer fan-out, but /registry/shapes is local-only —
// so goal-target inference could never pick a peer shape, and the walk's
// vessel-resolve satisfier judged peer targets "not live" and escalated to
// authoring instead of resolving (observed: gap-obsidian-status filed while the
// manual peer resolve over the libp2p egress worked). Union each
// PEER_DISCOVERY_ENDPOINTS registry's shapes into the known/live vocabularies;
// fail-open per peer, 60s cache.
let peerShapesCache: { shapes: string[]; fetchedAt: number } | null = null;
async function fetchPeerRegistryShapes(): Promise<string[]> {
  const peers = String(process.env.PEER_DISCOVERY_ENDPOINTS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (peers.length === 0) return [];
  const now = Date.now();
  if (peerShapesCache && now - peerShapesCache.fetchedAt < 60_000) return peerShapesCache.shapes;
  const out = new Set<string>();
  for (const peer of peers) {
    try {
      const r = await fetch(`${peer.replace(/\/+$/, "")}/registry/shapes`, {
        method: "GET",
        headers: { ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) continue;
      const j: any = await r.json();
      for (const s of (Array.isArray(j?.shapes) ? j.shapes : [])) { const v = String(s); if (v) out.add(v); }
    } catch { /* peer down — fail open */ }
  }
  peerShapesCache = { shapes: [...out], fetchedAt: now };
  return peerShapesCache.shapes;
}
async function fetchKnownShapes(): Promise<string[]> {
  const now = Date.now();
  if (knownShapesCache && now - knownShapesCache.fetchedAt < KNOWN_SHAPES_TTL_MS) {
    return knownShapesCache.shapes;
  }
  try {
    const r = await fetch(`${DISCOVERY_ENDPOINT.replace(/\/$/, "")}/registry/shapes`, {
      method: "GET",
      headers: { ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return knownShapesCache?.shapes ?? [];
    const j: any = await r.json();
    const local = (Array.isArray(j?.shapes) ? j.shapes : [])
      .map((s: unknown) => String(s))
      .filter(Boolean);
    const shapes = [...new Set([...local, ...(await fetchPeerRegistryShapes())])];
    if (shapes.length > 0) knownShapesCache = { shapes, fetchedAt: now };
    return shapes;
  } catch {
    return knownShapesCache?.shapes ?? [];
  }
}
// Leaf→authoring escalation (2026-06-25, operator-approved "scope-narrowed +
// verified"). When the walk hits a genuine CAPABILITY gap — a target shape with
// no producer AND no live resolver to bridge — it used to just stop. Instead we
// FILE a scope-narrowed substrateGap so the existing gap_to_feature →
// feature_compose → mitosis-cutover pipeline AUTHORS the missing producer, and a
// re-dispatch then reaches the goal. This is what makes capability EXPAND on goal
// DEMAND rather than by operator hand-authoring (reuse-before-mint still fires
// first: author_producer wraps any LIVE resolver; this only fires for a true code
// gap). Scope narrowing is the safety guard the operator chose: the authored
// producer must emit ONLY the missing shape X — by construction X is a
// backward-chained dependency of the goal's targets, so [X] ⊆ goal targets
// trivially. Verification (feature_compose typecheck+rollback, mitosis
// evidence/freshness gate, self-recovery immune system) is the real safety, not
// fencing authoring off the goal surface. The gap id is STABLE per missing shape
// so re-emissions upsert one row (dedup), never flood. feature_compose stays
// @shape-dispatch:private — the ONLY goal-reachable authoring path is this gap.
// Module-level cache for known shapes (5-minute TTL)
let _knownShapesCache: string[] | null = null;
let _knownShapesCacheTime = 0;
const KNOWN_SHAPES_TTL_MS = 5 * 60 * 1000;

async function getCachedKnownShapes(): Promise<string[]> {
  const now = Date.now();
  if (_knownShapesCache !== null && now - _knownShapesCacheTime < KNOWN_SHAPES_TTL_MS) {
    return _knownShapesCache;
  }
  const shapes = await fetchKnownShapes();
  _knownShapesCache = shapes;
  _knownShapesCacheTime = now;
  return shapes;
}

function canonicalizeShapeName(raw: string, known: string[]): string | null {
  function normalize(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }

  const normalizedRaw = normalize(raw);

  // (a) Exact match after normalization
  for (const k of known) {
    if (normalize(k) === normalizedRaw) {
      console.log(`[capability-gap] canonicalized ${raw} -> ${k}`);
      return k;
    }
  }

  // (b) Token-subset match: all tokens of known shape appear in raw tokens
  const rawTokens = normalizedRaw.split('_').filter(t => t.length > 0);
  let shortestMatch: string | null = null;
  for (const k of known) {
    const knownTokens = normalize(k).split('_').filter(t => t.length > 0);
    if (knownTokens.length === 0) continue;
    const allFound = knownTokens.every(kt => rawTokens.includes(kt));
    if (allFound) {
      if (shortestMatch === null || k.length < shortestMatch.length) {
        shortestMatch = k;
      }
    }
  }
  if (shortestMatch !== null) {
    console.log(`[capability-gap] canonicalized ${raw} -> ${shortestMatch} (token-subset)`);
    return shortestMatch;
  }

  // (c) Bespoke phrase check: contains space, or >4 underscore-separated tokens, or length >40
  const hasSpace = raw.includes(' ');
  const tokenCount = normalizedRaw.split('_').filter(t => t.length > 0).length;
  const tooLong = raw.length > 40;
  if (hasSpace || tokenCount > 4 || tooLong) {
    console.log(`[capability-gap] REFUSED bespoke shape name ${raw} (no canonical match)`);
    return null;
  }

  // (d) Compact genuinely-novel name passes through
  return raw;
}

async function fileCapabilityGap(missingShape: string, goal: string, goalTargets: string[]): Promise<string | null> {
  const knownShapes = await fetchKnownShapes();
  const canonicalShape: string | null = canonicalizeShapeName(missingShape, knownShapes);
  if (canonicalShape === null) {
    return null;
  }
  const slug = canonicalShape
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const id = `gap-${slug}`;
  const summary = `Capability gap: the goal-walk needs a producer for shape "${canonicalShape}" but no live resolver or activity produces it. AUTHOR a resolver that produces ONLY the shape "${canonicalShape}" — do NOT expand scope, produce no other output shape. Put it in the vessel that should own this capability (if development-vessel: add the resolver in src/resolvers/, register the shape in src/config.ts AND the dispatch case in src/routes/impulses.ts per the three-place rule; otherwise the owning vessel's resolver surface). Keep it dependency-free (Bun built-ins) and make it typecheck.`;
  try {
    const r = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({ impulse: { type: "substrateGap_write", pointer: { type: "substrateGap_write", gap: {
        id, category: "missing_capability", source: "substrate_detected", status: "open", summary,
        detected_at: new Date().toISOString(),
        classification_metadata: { kind: "capability_gap", missing_shape: canonicalShape, allowed_output_shapes: [canonicalShape], goal, goal_target_shapes: goalTargets, scope_narrowed: true },
      } } } }),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok ? id : null;
  } catch { return null; }
}
async function fileReachabilityGap(shape: string, goal: string, goalTargets: string[]): Promise<string | null> {
  if (!shape || shape.includes("{{") || shape.length < 2) return null; // skip unbound {{placeholder}} / garbage targets — not a real reachability gap
  const slug = shape.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const id = `reach-gap-${slug}`;
  const summary = `Reachability gap: shape "${shape}" is advertised by a producer, but the walk could not reach it from cold — the producer's required input_shapes are not producible from the goal pool. If the producer's resolver self-grounds (does not consume that input), declare the gating input as optional_input_shapes (non-gating) so it becomes cold-feasible; otherwise author a producer for the missing input. Do NOT expand scope.`;
  try {
    const r = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({ impulse: { type: "substrateGap_write", pointer: { type: "substrateGap_write", gap: {
        id, category: "unreachable_producer", source: "substrate_detected", status: "open", summary,
        detected_at: new Date().toISOString(),
        classification_metadata: { kind: "reachability_gap", unreachable_shape: shape, goal, goal_target_shapes: goalTargets, scope_narrowed: true },
      } } } }),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok ? id : null;
  } catch { return null; }
}

async function penaliseHollowTemplate(activityId: string, reason: string): Promise<void> {
  try {
    await fetch(`${ACTIVITY_API_ENDPOINT}/v2/activities/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({ activity_id: activityId, direction: "negative", intensity: 2, reason: `hollow completion (goal not reached): ${reason}`.slice(0, 200) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { /* non-fatal */ }
}
// Per-goal learning (2026-06-22). Record goal -> path -> reach into
// goal_execution_paths (keyed by goal_hash), so the SAME goal — whether from
// here (MCP) or the human-facing obsidian-vessel — accumulates per-goal Thompson
// α/β over subsequent attempts and the reaching path is attributable + reusable.
// path_activities is the attribution unit (the composition that ran). reached is
// the goal-reach verdict (NOT execution-status), so the per-goal posterior tracks
// genuine goal achievement, not hollow completion.
async function recordGoalPath(goalText: string, pathActivities: string[], reached: boolean, durationMs: number, costUsd: number): Promise<void> {
  if (!goalText || pathActivities.length === 0) return;
  try {
    await fetch(`${ACTIVITY_API_ENDPOINT}/v2/goal-paths`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({
        goal_text: goalText,
        goal_category: "meta",
        path_activities: pathActivities,
        success: reached,
        duration_ms: Math.round(durationMs) || 0,
        cost_usd: costUsd || 0,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { /* non-fatal */ }
}
// Durable-trace persistence for SATISFIER reaches (2026-06-28). The shape-graph
// walk's vessel-resolve satisfier produces a SYNTHETIC ExecutionTrace in-memory
// (the real engine traces flow to activity-api via the engine-internal
// TranslatingTraceSink, but a satisfier resolve never runs through the engine, so
// its trace was never persisted). That left outward satisfier reaches (obsidian
// write_note, analysis problem_detection, …) with NO durable execution trace —
// goal_execution_paths got the path (recordGoalPath), but activity_execution_traces
// stayed empty, so the reaches produced no trace-level learning signal and the
// same goal re-walked from scratch each time. We reuse the engine's own
// TranslatingTraceSink (identical schema mapping + defaulting; itself best-effort,
// swallows + logs all errors) so a satisfier trace lands EXACTLY like a template
// trace — same body contract, same status/failure mapping. Best-effort: a record()
// failure never throws into / slows the walk.
const satisfierTraceSink = new TranslatingTraceSink(ACTIVITY_API_ENDPOINT, API_KEY ?? "");
async function persistSatisfierTrace(trace: ExecutionTrace): Promise<void> {
  try {
    await satisfierTraceSink.record(trace);
  } catch (e) {
    console.warn(`[goal-host] satisfier-reach persistence failed (non-fatal): ${(e as Error).message}`);
  }
}
// Consult per-goal learning before selection: if a prior attempt at THIS goal
// reached it via a known path, prefer that path (improvement over subsequent
// attempts). Returns a template id to target, or null to fall through to the
// global template recommender.
async function recommendReachingPath(goalText: string): Promise<string | null> {
  if (!goalText) return null;
  try {
    const _sig = (await getCachedStateSignature())?.signature_hash;
    const r = await fetch(`${ACTIVITY_API_ENDPOINT}/v2/goal-paths/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({ goal_text: goalText, goal_category: "meta", ...(_sig ? { state_signature: _sig } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const paths = j?.recommended_paths ?? j?.body?.recommended_paths ?? [];
    // prefer a path that has genuinely reached this goal (success_rate>0) and is single-activity
    const best = paths.find((p: any) => (p.success_rate ?? p.goal_achieved) && Array.isArray(p.path_activities) && p.path_activities.length >= 1);
    return best?.path_activities?.[0] ?? null;
  } catch { return null; }
}
// In-flight approach-alteration (self-recovery DURING goal-seeking): recommend a
// DIFFERENT activity for the goal, excluding approaches that already failed to
// reach it this run. Returns the next template id to target, or null when no
// fresh candidate remains (exhausted = honest failure). Paired with the reach
// gate this turns goal-seeking into try → check → alter → retry, so the trace of
// the attempt that finally REACHES is what the ribosome mints into a new activity.
async function recommendExcluding(goalText: string, exclude: string[], repairSig?: string | null): Promise<string | null> {
  if (!goalText) return null;
  try {
    const r = await fetch(`${ACTIVITY_API_ENDPOINT}/v2/activities/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({ task_description: goalText, goal: goalText, exclude_activities: exclude, limit: 6, min_success_rate: 0, ...(repairSig ? { repair_signature: repairSig } : {}), ...((await getCachedStateSignature())?.signature_hash ? { state_signature: (await getCachedStateSignature())?.signature_hash } : {}) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const recs = j?.recommendations ?? j?.body?.recommendations ?? [];
    // Normalise ids (strip the activity:⟨…⟩ wrapper) so exclusion matches across
    // the wrapped/unwrapped forms the recommend + runGoal paths use.
    const norm = (s: string) => s.replace(/^activity:/, "").replace(/[⟨⟩]/g, "").trim();
    const excludedNorm = new Set(exclude.map(norm));
    for (const x of (Array.isArray(recs) ? recs : [])) {
      const id = String((x && (x.template_id || x.id || x.activity_id || x.variant_id)) || "");
      if (id && !excludedNorm.has(norm(id))) return id;
    }
    return null;
  } catch { return null; }
}
// Reach → mint (operator: "the traces of the working attempts will be minted as
// the beginnings of new activities"). When a goal genuinely REACHES, dispatch the
// ribosome-extract activity on its trace so the working trajectory is assembled
// into a new reusable activity. This is a far more reliable mint trigger than the
// ribosome-vessel's WS all-tasks-succeeded heuristic — which is starved by WS
// instability + a strict gate and has NEVER fired (0 ribosome-extract executions).
// ribosome-extract dedupes against existing templates, so re-runs of known
// activities don't mint duplicates — only NOVEL reached trajectories become seeds.
// Build a COMPOSITE ExecutionTrace from a reached multi-step walk chain so a
// derive→emit composition (whose individual steps are vessel-resolve satisfiers)
// is mintable as ONE recipe with taskCount≥2. Each chain entry becomes a task that
// outputs the shape it produced (parsed from the satisfier id `satisfier:<shape>`),
// preserving production order so the ribosome extracts a genuine sequence. The id
// is DETERMINISTIC per chain (no timestamp) so re-running the same composition
// UPSERTs one learned-* row (the ribosome's own dedup) rather than spawning dups.
function buildCompositeTraceFromChain(
  chain: string[],
  chainExecIds: string[],
  producedShapes: string[],
  durationMs: number,
  costUsd: number,
  tags?: string[],
  poolImpulses?: Array<{ id: string; metadata?: { shape?: string } }>,
): ExecutionTrace {
  const shapeOf = (id: string): string => (id.startsWith("satisfier:") ? id.slice("satisfier:".length) : id);
  // Map each produced shape to its REAL pool-impulse id so the composite trace's
  // tasks carry concrete output impulse ids instead of empty arrays. The ribosome's
  // acquire_trace_signature task fetches the trace WITH per-impulse signatures; with
  // empty impulse arrays it has nothing to extract and synthesize_template produces
  // nothing (why composite reaches REACHED but never minted a learned-* template).
  // Each composition step also CONSUMES the prior step's output (the data-flow
  // binding that makes it a genuine link), so step i's inputs are step i-1's outputs.
  const shapeToImpulseId = new Map<string, string>();
  for (const imp of poolImpulses ?? []) {
    const sh = imp.metadata?.shape;
    if (sh && !shapeToImpulseId.has(sh)) shapeToImpulseId.set(sh, imp.id);
  }
  const tasks = chain.map((id, i) => {
    const sh = shapeOf(id);
    const outId = shapeToImpulseId.get(sh);
    const prevSh = i > 0 ? shapeOf(chain[i - 1]) : undefined;
    const prevId = prevSh ? shapeToImpulseId.get(prevSh) : undefined;
    return {
      taskId: `compose-step-${i + 1}`,
      description: `produce ${sh} (composition step ${i + 1})`,
      resolverId: sh,
      resolverTier: "pattern" as const,
      inputImpulseIds: prevId ? [prevId] : [],
      outputImpulseIds: outId ? [outId] : [],
      outputShapes: producedShapes.includes(sh) ? [sh] : [],
      success: true,
    };
  });
  const allOutputImpulseIds = [...new Set(tasks.flatMap((t) => t.outputImpulseIds))];
  // Stable composite SLUG (the ordered shape sequence) drives the deterministic
  // templateId — that is what the ribosome UPSERTs into one learned-<slug>. But the
  // execution_id has a UNIQUE index, so the TRACE id must differ per run or a second
  // composition of the same shape-pair 500s on the index (`already contains`),
  // leaving the reached trace unpersisted and the mint extracting a stale one.
  // Derive a run-unique suffix from chainExecIds (already unique per run; no clock
  // dependence) so the trace id is per-run while the templateId stays stable.
  const slug = chain.map(shapeOf).join("-to-").replace(/[^a-zA-Z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").toLowerCase().slice(0, 64) || "composition";
  const runSrc = chainExecIds.join("|");
  let _h = 0;
  for (let i = 0; i < runSrc.length; i++) _h = ((_h << 5) - _h + runSrc.charCodeAt(i)) | 0;
  const runSuffix = (_h >>> 0).toString(36).slice(0, 8) || "run";
  return {
    id: `walk-composite-${slug}-${runSuffix}`,
    templateId: `composition:${slug}`,
    templateName: `walk composition (${chain.map(shapeOf).join(" → ")})`,
    status: "completed",
    parentExecutionId: undefined,
    compositionChain: [...chainExecIds],
    inputImpulseIds: [],
    outputImpulseIds: allOutputImpulseIds,
    tasks,
    costUsd,
    durationMs,
    tags,
    metadata: { satisfier: false, composite: true, chain },
  } as ExecutionTrace;
}

async function mintReachedTrace(trace: { id?: string; status?: string; templateId?: string; durationMs?: number; costUsd?: number; tasks?: Array<{ outputShapes?: string[] }>; compositionChain?: string[]; outputImpulseIds?: string[] }): Promise<void> {
  const executionId = trace?.id;
  if (!executionId) return;
  try {
    // Execute ribosome-extract via the LOCAL executor (host.runGoal), not by
    // POSTing activityDispatch to activity-api /v2/impulses/resolve — activity-api
    // is the trace store, NOT an executor, so that dispatch never runs the activity
    // (why ribosome-extract had 0 executions despite the ribosome-vessel dispatching
    // it for ages). Calling host.runGoal runs the engine and bypasses the HTTP reach
    // gate (no goal text on the mint call → no recursion / re-mint).
    // Supply the FULL lifecycle payload the template expects (normally set by the
    // lifecycle dispatcher) so its LLM tasks (assess/synthesize/validate) have the
    // trace metadata, not just executionId — otherwise placeholders are empty and
    // synthesis produces garbage / fails.
    const tasks = Array.isArray(trace.tasks) ? trace.tasks : [];
    const outputShapes = [...new Set(tasks.flatMap((t) => t.outputShapes ?? []))];
    // REUSE-BEFORE-MINT (2026-07-03): a single-task, non-composed reach is ALREADY one
    // reusable template — extracting it just clones the source template with a
    // runtime-derived (over-declared) input contract. The ribosome's value is
    // compressing MULTI-step/composed chains; skip trivial reaches so we don't mint
    // near-duplicate learned-<parent> variants that reintroduce input-overload.
    const composedDepth = Array.isArray(trace.compositionChain) ? trace.compositionChain.length : 0;
    if (tasks.length <= 1 && composedDepth === 0) {
      console.log(`[goal-host-vessel] reach->mint: SKIP trivial single-template reach for ${executionId} (taskCount=${tasks.length}) — source template is already reusable`);
      return;
    }
    const lifecycle = {
      executionId,
      status: trace.status === "failed" ? "failed" : "success",
      taskCount: tasks.length,
      durationMs: trace.durationMs ?? 0,
      costUsd: trace.costUsd ?? 0,
      templateId: trace.templateId ?? "",
      templateName: trace.templateId ?? "",
      templateAuthor: "",
      outputShapes,
      depth: Array.isArray(trace.compositionChain) ? trace.compositionChain.length : 0,
      impulseCount: trace.outputImpulseIds?.length ?? 0,
      hasGoalContext: true,
      // ribosome-extract's acquire_trace_signature task short-circuits the whole
      // chain unless lifecycle.qualityEligible === 'true' (normally stamped by the
      // lifecycle dispatcher). On the reach→mint path there is no dispatcher, so we
      // stamp it here — a genuine REACH already passed the goal-reach gate, which is
      // exactly the eligibility signal the chain wants. Without this the extract
      // skips silently and nothing is ever synthesized.
      qualityEligible: true,
    };
    await host.runGoal(`extract reusable template from execution ${executionId}`, {
      // Use the UNWRAPPED catalogue id. The shared in-memory catalogue
      // (SHARED_TEMPLATES / TEMPLATES_BY_ID) is keyed by the bare id
      // "ribosome-extract" with the full 7-task chain. Passing the wrapped form
      // "activity:⟨ribosome-extract⟩" MISSES the local catalogue (exact-key Map)
      // and falls back to the STALE activity-api DB copy, which executes as a
      // 0-task no-op (status=success, 0 LLM calls, nothing synthesized/written)
      // — the real reason reach→mint persisted nothing despite firing.
      targetTemplateId: "ribosome-extract",
      // applyExtraction:true flips the chain out of proposal-only mode so the
      // synthesized template is actually PERSISTED via activityTemplate_write. The
      // template's own dedup makes this safe against sprawl: synthesize_template
      // mints a DETERMINISTIC id `learned-<parent-slug>` (no timestamp/hash) so
      // re-running the same reach UPSERTs and refines ONE row instead of spawning
      // near-duplicates, the quality gate (≥qualityThreshold) rejects weak traces,
      // and the recursion-safety skip-list excludes ribosome-family parents.
      variables: { executionId, lifecycle, applyExtraction: true },
    });
    console.log(`[goal-host-vessel] reach→mint: ran ribosome-extract for ${executionId} (taskCount=${lifecycle.taskCount}, shapes=${JSON.stringify(outputShapes)})`);
  } catch (e) { console.warn(`[goal-host-vessel] reach→mint failed for ${trace?.id}: ${(e as Error).message}`); }
}

interface GoalSeekResult {
  result: Awaited<ReturnType<typeof host.runGoal>> | null;
  status: "failed" | "completed";
  selectedTemplateId?: string;
  completionShapes: string[] | null;
  attempts: number;
  goalReachReason?: string;
  reached: boolean;
  /**
   * Explicit executionId for GoalSeekResult paths that don't carry a full
   * result.trace — notably the edit-intent → feature_compose routing branch,
   * whose durable artifact is the cutover git sha, not a runGoal trace. The
   * async dispatch handler prefers this over result?.trace?.id so routed
   * dispatches populate record.executionId (which provide_feedback needs).
   */
  executionId?: string;
}

// Normalise an activity id by stripping the `activity:⟨…⟩` wrapper the recommend +
// runGoal paths use, so chain/exclusion membership matches across the wrapped and
// unwrapped forms. Mirrors the `norm` helper in recommendExcluding.
function normActivityId(s: string): string {
  return s.replace(/^activity:/, "").replace(/[⟨⟩]/g, "").trim();
}

// A recommend/discover candidate normalised to the fields the walk reasons over.
interface WalkCandidate {
  id: string;            // raw id (used for fetch / chain record)
  inputShapes: string[]; // declared input_shapes (bare names)
  outputShapes: string[];// declared output_shapes (bare names)
}

function readCandidateShapes(x: any): WalkCandidate | null {
  const id = String((x && (x.template_id || x.id || x.activity_id || x.variant_id)) || "");
  if (!id) return null;
  const norm = (arr: unknown): string[] =>
    Array.isArray(arr) ? arr.map((s) => String(s)).filter(Boolean) : [];
  // discover-by-shapes returns shapes under input_schema.required_shapes /
  // output_schema.produces_shapes; recommend returns input_shapes/output_shapes.
  // Read both so the walk sees a candidate's real input/output contract.
  const optionalInputShapes = norm(x.optional_input_shapes ?? x.optionalInputShapes ?? x.input_schema?.optional_shapes);
  const declaredInputs = norm(x.input_shapes ?? x.inputShapes ?? x.input_schema?.required_shapes);
  const inputShapes = declaredInputs.filter((s) => !optionalInputShapes.includes(s));
  const outputShapes = norm(x.output_shapes ?? x.outputShapes ?? x.output_schema?.produces_shapes);
  return { id, inputShapes, outputShapes };
}

// MINT-AS-YOU-GO (the "Reserve Improvisation" slot at the WALK step level,
// 2026-06-24). When the shape-graph walk needs a target shape that NO existing
// activity produces (discover-by-shapes found no producer), but the substrate
// HAS a live resolver for that shape (advertised by discovery at /registry/shapes),
// mint a thin wrapper activity whose single task invokes that resolver. This
// wraps the substrate's orphaned resolvers (live resolver shapes that no activity
// invokes) on demand, so the walk can genuinely produce the shape and continue
// instead of stopping at a phantom capability gap.
//
// Reuse-Before-Mint is already satisfied at the call site: we only reach the mint
// after the backward-chain discover found no producer.
async function mintResolverWrapper(shape: string): Promise<string | null> {
  const template = {
    id: `auto-mint-${shape}`,
    name: `auto-mint:${shape}`,
    description: `Auto-minted wrapper around the ${shape} resolver (Reserve-Improvisation): no existing activity produced this shape, so the walk wraps the live resolver on demand.`,
    input_shapes: [] as string[],
    inputShapes: [] as string[],
    output_shapes: [shape],
    outputShapes: [shape],
    tags: ["auto_minted", "improvise", "horizon:walk"],
    variables: [] as unknown[],
    tasks: [
      {
        id: "produce",
        description: `invoke ${shape} resolver`,
        resolver: shape,
        config: { type: shape },
        output_shapes: [shape],
        outputShapes: [shape],
      },
    ],
    proposed: false,
    org_id: "organizations:substrate",
  };
  try {
    const r = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({ impulse: { type: "activity_create_variant", pointer: { type: "activity_create_variant", template } } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const variantId = j?.body?.variantId ?? j?.variantId ?? null;
    return typeof variantId === "string" && variantId ? variantId : null;
  } catch {
    return null;
  }
}

// Shape-graph WALK (2026-06-23). The DEFAULT goal-execution strategy: instead of
// picking ONE whole template by goal-text and treating its status as "reached",
// walk the shape graph across MULTIPLE activities — at each step pick an activity
// whose declared inputs are satisfied by the accumulated impulse POOL and whose
// outputs add a NEW shape (forward progress), seed it with the pool, execute it,
// merge its produced shapes back into the pool, and continue until the target
// output shapes are all produced (or no shape-feasible step remains). The selected
// activities form the composition `chain`; the threaded parent/composition ids make
// the steps a RECORDED chain, and recordGoalPath stores the full multi-activity path.
//
// There is NO env flag / opt-in toggle (operator forbade flags). MAX_STEPS is a
// tuning constant. When the walk cannot take even one shape-feasible step
// (chain.length === 0), runGoalWithRecovery falls through to the single-template
// recovery loop — graceful degradation, not a break.
async function runGoalAsPoolWalk(
  goal: string,
  opts: {
    variables: Record<string, unknown>;
    tags?: string[];
    parentExecutionId?: string;
    compositionChain?: string[];
    expectedOutputShapes?: string[];
    // DERIVATION-INTENT (composition, 2026-06-30): the subset of expectedOutputShapes
    // that are TERMINAL emit targets (e.g. obsidian:note). When set, the satisfier
    // DEFERS satisfying these while any non-terminal (intermediate) target shape is
    // still unproduced, and BINDS the terminal write's content from the produced
    // intermediate findings. Empty/undefined ⇒ no deferral (unchanged behaviour).
    terminalOutputShapes?: string[];
    surface: string;
    /** Reason plane: caller-owned sink; walk decision lines are pushed here (additive to console.log). */
    stepSink?: string[];
  },
): Promise<GoalSeekResult> {
  // Reason-plane tap: mirror a decision line to both stdout and the caller's
  // stepSink (if provided). Additive — never alters control flow.
  const tap = (m: string): void => { console.log(m); opts.stepSink?.push(m); };
  const MAX_STEPS = parseInt(process.env.GOAL_HOST_WALK_MAX_STEPS ?? "40", 10);
  // Terminal emit targets to DEFER until intermediates are produced (composition).
  const terminalShapes = new Set<string>(opts.terminalOutputShapes ?? []);

  // Live resolver shapes advertised by discovery — a shape present here is
  // RESOLVABLE (some vessel resolves it), so a wrapper activity invoking it as a
  // resolver genuinely produces the impulse. Lazily fetched once and cached;
  // tolerant of failure (empty Set ⇒ never mint, fall through to escalate).
  let liveResolverShapes: Set<string> | null = null;
  const liveShapes = async (): Promise<Set<string>> => {
    if (liveResolverShapes) return liveResolverShapes;
    try {
      const r = await fetch(DISCOVERY_SHAPES_ENDPOINT, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const j: any = await r.json();
        const shapes = Array.isArray(j?.shapes) ? j.shapes.map((s: unknown) => String(s)).filter(Boolean) : [];
        liveResolverShapes = new Set<string>(shapes);
      } else {
        liveResolverShapes = new Set<string>();
      }
    } catch {
      liveResolverShapes = new Set<string>();
    }
    // Peer-federated capabilities are LIVE too: resolvable via discovery peer
    // fan-out + the libp2p egress (endpointForShape already routes them). This
    // union is what lets the satisfier reach a peer vessel instead of filing an
    // authoring gap for a capability that already exists (SC-P4, 2026-07-02).
    for (const s of await fetchPeerRegistryShapes()) liveResolverShapes.add(s);
    return liveResolverShapes;
  };
  const minted = new Set<string>(); // shapes we've already minted a producer for this walk

  // ── 1. Seed the POOL ───────────────────────────────────────────────────────
  // producedShapes is the set of shapes currently available to consume; poolImpulses
  // are the concrete impulses (with content) we seed into each step's execution.
  const producedShapes = new Set<string>();
  const poolImpulses: Impulse[] = [];
  let impulseSeq = 0;
  const mkImpulse = (shape: string, content: unknown, summary?: string): Impulse => ({
    id: `walk-${shape}-${++impulseSeq}`,
    pointer: { type: "memo" },
    metadata: { shape, summary: summary ?? `pool impulse (${shape})`, producedBy: "goal-host-walk" },
    loaded: true,
    content,
  });
  const addToPool = (shape: string, content: unknown, summary?: string): void => {
    if (!shape || producedShapes.has(shape)) return;
    producedShapes.add(shape);
    poolImpulses.push(mkImpulse(shape, content, summary));
  };
  // DATA-FLOW BINDING: expose each pool impulse's CONTENT as a variable keyed by
  // its shape, so a downstream task's `{{shape}}` placeholder interpolates from
  // the UPSTREAM activity's output content. This is what turns activities from
  // environmentally-grounded SOURCES into genuine LINKS (B consumes A's output).
  const poolVars = (): Record<string, unknown> => {
    // Seed the goal TEXT as the default `{{goal}}` (2026-06-24). The goal impulse's
    // content is an object ({ goal }), so without this default `{{goal}}` interpolated
    // to a stringified object — breaking tasks that bind from the goal text (e.g.
    // author_producer's goal_file_extract entry step). Explicit opts.variables win.
    const v: Record<string, unknown> = { goal, ...opts.variables };
    for (const imp of poolImpulses) {
      const sh = (imp.metadata as { shape?: string } | undefined)?.shape;
      if (sh && !(sh in v)) v[sh] = imp.content;
    }
    return v;
  };

  // ── VESSEL-RESOLVE SATISFIER (additive, 2026-06-28) ────────────────────────
  // When a MISSING target/input shape has a LIVE resolver advertised by a
  // connected vessel (per discovery / shapeEndpointMap), bring that vessel's
  // REAL resolve capability into the pool directly — a genuine resolve call —
  // BEFORE falling back to authoring a hollow `auto-bridge-*` wrapper. This is
  // the "resolvers live where data lives" principle applied at WALK time: the
  // obsidian intake loop writes notes by calling obsidian's write_note resolver
  // directly (port 27182); the goal walk should reach the SAME capability rather
  // than minting a hollow bridge that produces no shapes.
  //
  // STRICTLY ADDITIVE + SCOPED: returns the resolved content on genuine success
  // (success !== false AND non-empty content) and null on ANY failure, so the
  // existing bridge-author / escalate path remains the unchanged fallback. We do
  // NOT register resolvers, mint templates, or touch selection here.
  //
  // ARG DERIVATION: a raw resolve needs pointer args the pool may not carry
  // (e.g. obsidian:write_note needs {path, content}). We seed the pointer from
  // poolVars (so `{{path}}`/`{{content}}` vars + already-produced shape content
  // flow in) and, when an LLM is available, additionally LLM-extract the pointer
  // args for THIS shape from the goal text. The vessel itself is the validator:
  // a wrong/empty pointer → success:false / empty → we return null → fallback.
  const satisfierTried = new Set<string>();
  const llmExtractPointerArgs = async (shape: string): Promise<Record<string, unknown> | null> => {
    if (!LLM_VESSEL_ENDPOINT) return null;
    const prompt = `A resolver for the impulse shape "${shape}" must be invoked to satisfy this goal. Extract ONLY the pointer argument fields that the resolver needs, from the goal text. For a write/note shape that means fields like "path" and "content"; for a read shape a "path" or "query"; emit only fields the goal actually specifies or clearly implies.

GOAL: ${goal}

Respond with ONLY a flat JSON object of pointer arg fields (no "type" key, no nesting). If the goal does not specify any args, respond with {}.`;
    try {
      const r = await fetch(`${LLM_VESSEL_ENDPOINT.replace(/\/$/, "")}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "llm_completion", prompt, model: "claude-haiku-4-5-20251001" }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) return null;
      const j: any = await r.json();
      const text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
      const m = String(text).match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]);
      const args = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : null;
      if (!args) return null;
      // ARG-ALIAS EXPANSION (2026-06-29): the generic LLM extraction can't know a
      // specific resolver's exact pointer field name (analysis-vessel's
      // problem_detection reads `file_paths`/`filePaths`, code_quality reads
      // `file_path`/`filePath`/`path`). When the goal carries a filesystem path,
      // mirror it across the canonical file-arg aliases so a file-reading resolver
      // binds it regardless of which name it checks. Keeps the satisfier general
      // (no per-vessel special-casing) instead of failing "filePaths is required".
      const looksLikePath = (s: unknown): s is string =>
        typeof s === "string" && /(^|\/)[\w.-]+\.[A-Za-z0-9]+$/.test(s.trim()) && !/\s/.test(s.trim());
      const rawPathVal =
        Object.values(args).find(looksLikePath) ??
        // Fall back to a path literal in the goal text itself if the LLM dropped it.
        (goal.match(/[^\s"']*\/[^\s"']+\.[A-Za-z0-9]+/)?.[0]);
      // PATH-MOUNT NORMALISATION (2026-06-30): a goal carries a repo-relative path
      // (e.g. "repos/<vessel>/src/index.ts"), but a file-reading vessel resolves it
      // against ITS OWN cwd (analysis-vessel's is /vessels/analysis-vessel), yielding
      // ENOENT — the walk then binds that read_error as the composed note body and
      // the reach-gate correctly judges it HOLLOW. Every vessel shares the same
      // /workspace repo mirror, so rooting a relative "repos/…" path at
      // /workspace/repos/… makes it resolvable regardless of the resolving vessel's
      // cwd. Absolute paths and non-repo-relative paths pass through unchanged.
      const pathVal =
        (typeof rawPathVal === "string" && /^repos\//.test(rawPathVal.trim()))
          ? `/workspace/${rawPathVal.trim()}`
          : rawPathVal;
      if (typeof pathVal === "string" && pathVal.length > 0) {
        for (const k of ["path", "file_path", "filePath", "logFilePath"]) if (!(k in args)) args[k] = pathVal;
        for (const k of ["file_paths", "filePaths"]) if (!(k in args)) args[k] = [pathVal];
      }
      return args;
    } catch { return null; }
  };
  // Look up a shape's vessel endpoint (registry map first, then discovery).
  const endpointForShape = async (shape: string): Promise<{ endpoint: string; resolvePath: string; resolvedByVesselId?: string } | null> => {
    const mapped = shapeEndpointMap.get(shape);
    if (mapped?.endpoint && !(opts.variables as Record<string, unknown> | undefined)?.target_vessel_id && process.env.PREFER_LIBP2P_ROUTE !== "1") return { endpoint: mapped.endpoint, resolvePath: mapped.resolvePath };
    try {
      const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
        body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
        signal: AbortSignal.timeout(5_000),
      });
      const dj = await dr.json() as { content?: { vessels?: Array<{ id?: string; vesselId?: string; endpoint?: string; resolve_endpoint?: string; discoveredVia?: string; peerEndpoint?: string; protocol?: string; libp2p_multiaddr?: string[] }> } };
      const vessels = dj?.content?.vessels ?? [];
      const targetVid = (opts.variables as Record<string, unknown> | undefined)?.target_vessel_id;
      // Transport failover (2026-07-02): iterate discovery candidates instead of
      // blindly taking vessels[0] — a vessel that died inside discovery's 5-min
      // TTL window would otherwise be returned and the resolve would fail with no
      // other producer of the shape ever tried. Order: target_vessel_id match
      // first (when given), then discovery order. Peer/libp2p candidates are
      // accepted without probing (reachability is mediated by relay/gateway);
      // plain candidates are probed via /health (1.5s). If nothing passes the
      // probe, fall back to the first candidate — never regress below status quo.
      const target = typeof targetVid === "string" && targetVid
        ? vessels.find((x) => x.vesselId === targetVid || x.id === targetVid)
        : undefined;
      const ordered = target ? [target, ...vessels.filter((x) => x !== target)] : vessels;
      const routeFor = (v: { id?: string; endpoint?: string; resolve_endpoint?: string; discoveredVia?: string; peerEndpoint?: string; protocol?: string; libp2p_multiaddr?: string[] }) => {
        if (v.discoveredVia === "peer" && v.protocol === "libp2p" && Array.isArray(v.libp2p_multiaddr) && v.libp2p_multiaddr[0]) {
          // libp2p-reachable peer: route the resolve through the local federation-transport
          // egress (goal-host has no libp2p deps), passing the peer multiaddr as ?target=.
          return { endpoint: FED_TRANSPORT_EGRESS, resolvePath: `/egress/resolve?target=${encodeURIComponent(v.libp2p_multiaddr[0])}`, resolvedByVesselId: v.id };
        }
        if (process.env.PREFER_LIBP2P_ROUTE === "1" && Array.isArray(v.libp2p_multiaddr) && v.libp2p_multiaddr[0]) {
          // Operator-flagged location transparency: prefer the libp2p egress route for ANY
          // candidate advertising a multiaddr, regardless of discoveredVia. Flag OFF = no change.
          return { endpoint: FED_TRANSPORT_EGRESS, resolvePath: "/egress/resolve?target=" + encodeURIComponent(v.libp2p_multiaddr[0]), resolvedByVesselId: v.id };
        }
        // Cross-substrate: when discovery returns a peer-advertised vessel, prefer
        // routing the resolve through the peer's gateway endpoint and tag the
        // peer vessel id as resolved_by_vessel_id for execution-trace provenance.
        if (v.discoveredVia === "peer" && v.peerEndpoint) {
          return { endpoint: v.peerEndpoint.replace(/\/+$/, ""), resolvePath: v.resolve_endpoint || "/resolve", resolvedByVesselId: v.id };
        }
        return { endpoint: (v.endpoint ?? "").replace(/\/+$/, ""), resolvePath: v.resolve_endpoint || "/resolve" };
      };
      let first: { endpoint: string; resolvePath: string; resolvedByVesselId?: string } | null = null;
      for (const cand of ordered) {
        if (!cand?.endpoint) continue;
        const route = routeFor(cand);
        if (first === null) first = route;
        if (cand.discoveredVia === "peer") return route;
        try {
          const probe = await fetch(`${cand.endpoint.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(1_500) });
          if (probe.ok) return route;
        } catch { /* dead candidate — try the next producer of this shape */ }
      }
      return first;
    } catch { return null; }
  };
  // Raw resolve call to a vessel for one shape; returns non-empty content or null.
  const rawResolve = async (shape: string, endpoint: string, resolvePath: string, extraArgs: Record<string, unknown>): Promise<unknown | null> => {
    const base = poolVars();
    delete (base as Record<string, unknown>).goal; // don't let the goal-object default shadow real args
    const pointer: Record<string, unknown> = { type: shape, ...base, ...extraArgs };
    let resp: Response;
    try {
      resp = await fetch(`${endpoint}${resolvePath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
        body: JSON.stringify({ impulse: { pointer } }),
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
    } catch { return null; }
    const bodyText = await resp.text();
    if (!resp.ok) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
    let content: unknown = parsed;
    const pObj = (typeof parsed === "object" && parsed !== null) ? parsed as Record<string, unknown> : null;
    if (pObj) {
      if (pObj["success"] === false) return null;
      // A resolver that rejected the pointer returns { error: "..." } (e.g.
      // analysis-vessel's "filePaths is required") with no content/body. That is a
      // FAILURE, not produced content — without this the walk would "produce" the
      // shape with an error object as its content and fool the reach-gate. Return
      // null so the satisfier falls through to the unchanged bridge/escalate path.
      if (typeof pObj["error"] === "string" && pObj["error"].length > 0 && !("content" in pObj) && !("body" in pObj)) return null;
      if ("content" in pObj) content = pObj["content"];
      else if ("body" in pObj) content = pObj["body"];
    }
    if (content == null) return null;
    if (typeof content === "string" && content.trim().length === 0) return null;
    if (Array.isArray(content) && content.length === 0) return null;
    return content;
  };
  // LLM-pick the ACTION shape (+args) that PRODUCES the missing target, among the
  // target vessel's other live shapes. This is what turns a read-only target
  // (obsidian:note) into a genuine write (obsidian:write_note) when the goal asks
  // for one — without hardcoding any vessel: the vessel's own advertised surface
  // is the action menu, the LLM maps goal→action, the vessel validates the args.
  const llmPickProducingAction = async (target: string, siblings: string[], correction?: string): Promise<{ shape: string; args: Record<string, unknown> } | null> => {
    if (!LLM_VESSEL_ENDPOINT || siblings.length === 0) return null;
    // When the vessel REFUSED a prior attempt, feed its own rejection reason back to
    // the LLM so it corrects the args (e.g. obsidian's "path must end in .md and
    // start with Substrate/"). The vessel's validation message is the constraint —
    // no per-vessel rule is hardcoded here; the vessel teaches the extractor.
    const correctionBlock = correction
      ? `\n\nA PRIOR attempt was REFUSED by the vessel with this reason — fix the args to satisfy it: "${correction}"`
      : "";
    // Known arg constraints surfaced UP FRONT so the first attempt is valid (saves
    // one LLM round-trip vs the refuse-then-retry path). General hook: if any
    // sibling is an obsidian write/note action, the vault path constraint is known,
    // so inject it pre-emptively. No behaviour is hardcoded beyond this hint — the
    // vessel's own refusal reason still drives correction if the first try is wrong.
    const obsidianWrite = !correction && siblings.some((s) => /^obsidian:(write_note|write|note)$/.test(s));
    const constraintBlock = obsidianWrite
      ? `\n\nKNOWN CONSTRAINT: obsidian note paths must be vault-relative, start with "Substrate/", and end in ".md" (e.g. "Substrate/<descriptive-name>.md"). The write action also requires a non-empty "content" field. Emit a valid path on the FIRST attempt.`
      : "";
    const prompt = `The goal needs the impulse shape "${target}" to exist, but resolving it directly returned nothing (it does not exist yet). The vessel that owns "${target}" also offers these resolver shapes that may PRODUCE/CREATE it: ${JSON.stringify(siblings)}.${constraintBlock}

GOAL: ${goal}${correctionBlock}

If one of those sibling shapes is the action that would create what the goal asks for (e.g. a write/create action), respond with ONLY JSON {"shape": "<sibling shape>", "args": { ...flat pointer arg fields extracted from the goal, e.g. path/content }}. If none of them is an appropriate creating action for this goal, respond with {"shape": null}.`;
    try {
      const r = await fetch(`${LLM_VESSEL_ENDPOINT.replace(/\/$/, "")}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "llm_completion", prompt, model: "claude-haiku-4-5-20251001" }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) return null;
      const j: any = await r.json();
      const text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
      const m = String(text).match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]) as { shape?: unknown; args?: unknown };
      if (typeof parsed?.shape !== "string" || !siblings.includes(parsed.shape)) return null;
      const args = (parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)) ? parsed.args as Record<string, unknown> : {};
      return { shape: parsed.shape, args };
    } catch { return null; }
  };
  // CONTENT-BINDING (composition, 2026-06-30): build a human-readable findings
  // digest from the produced INTERMEDIATE shapes' content, to be bound as the body
  // of a deferred TERMINAL write. This is what makes the composed note carry REAL
  // findings (e.g. problem_detection's problems[]) instead of a goal-text placeholder
  // — the difference between a genuine composition and a hollow one. Returns "" when
  // no intermediate content is available (caller then falls back to LLM-extracted args).
  const boundFindingsFromIntermediates = (): string => {
    if (terminalShapes.size === 0) return "";
    const parts: string[] = [];
    for (const imp of poolImpulses) {
      const sh = (imp.metadata as { shape?: string } | undefined)?.shape;
      if (!sh || terminalShapes.has(sh) || sh === "goal") continue;
      let c: string;
      try { c = typeof imp.content === "string" ? imp.content : JSON.stringify(imp.content, null, 2); }
      catch { c = String(imp.content); }
      if (!c || c.trim().length === 0 || c.trim() === "{}" || c.trim() === "[]") continue;
      parts.push(`## ${sh}\n\n\`\`\`json\n${c.slice(0, 8000)}\n\`\`\``);
    }
    if (parts.length === 0) return "";
    return `# Findings\n\n${parts.join("\n\n")}\n`;
  };
  const vesselResolveShape = async (shape: string): Promise<{ content: unknown } | null> => {
    if (!shape || producedShapes.has(shape) || satisfierTried.has(shape)) return null;
    satisfierTried.add(shape);
    const ep = await endpointForShape(shape);
    if (!ep) return null;
    // For a deferred TERMINAL write, the body must be the produced intermediate
    // findings (composition), not the LLM's goal-text guess. Computed once here.
    const boundBody = terminalShapes.has(shape) ? boundFindingsFromIntermediates() : "";
    // CONTENT-BINDING: for a deferred terminal write, force the body to the produced
    // intermediate findings (real analysis) over any LLM goal-text guess. The path/
    // title args are kept; only the content body is bound. Used on BOTH the direct
    // resolve path (step a — the terminal IS the write action, e.g. obsidian:write_note)
    // and the action-then-read path (step b — read-only shape produced by a sibling).
    const bindBody = (args: Record<string, unknown>): Record<string, unknown> => {
      if (!boundBody) return args;
      const out = { ...args };
      for (const k of ["content", "body", "text", "note", "markdown"]) if (k in out) out[k] = boundBody;
      if (!("content" in out)) out["content"] = boundBody;
      return out;
    };
    // (a) Try resolving the target shape directly with goal-extracted args.
    const directArgsRaw = (await llmExtractPointerArgs(shape)) ?? {};
    const directArgs = bindBody(directArgsRaw);
    if (boundBody) console.log(`[goal-host-vessel] walk(${opts.surface}): bound terminal "${shape}" content from produced intermediate findings (${boundBody.length} chars) — composition, not placeholder`);
    const direct = await rawResolve(shape, ep.endpoint, ep.resolvePath, directArgs);
    if (direct != null) return { content: direct };
    // (b) ACTION-THEN-READ: the target didn't resolve (e.g. a read-only shape for a
    //     not-yet-existing artifact). Find a sibling live shape on the SAME vessel
    //     that PRODUCES it (LLM-mapped from the goal), invoke that action, then
    //     re-read the target. This reaches genuine write capability (obsidian
    //     write_note) without minting a hollow bridge.
    const live = await liveShapes();
    const siblings = [...live].filter((s) => s !== shape && (shapeEndpointMap.get(s)?.endpoint === ep.endpoint));
    if (siblings.length === 0) return null;
    // A vessel can ACCEPT the call at the transport level (success:true, non-empty
    // content) yet REFUSE the args inside the content body — e.g. obsidian returns
    // {"wrote":false,"refused":true,"reason":"path must end in .md ..."}. rawResolve
    // sees that as produced content, so the walk would "produce" a refusal and go
    // HOLLOW. Detect such a soft-refusal and surface its reason so we can re-ask the
    // LLM with the vessel's own constraint as corrective feedback (general; no
    // per-vessel path rule baked in).
    const refusalReason = (result: unknown): string | null => {
      let obj: unknown = result;
      if (typeof obj === "string") { try { obj = JSON.parse(obj); } catch { return null; } }
      if (!obj || typeof obj !== "object") return null;
      const o = obj as Record<string, unknown>;
      const refused = o["refused"] === true || o["wrote"] === false || o["written"] === false ||
        o["success"] === false || (typeof o["error"] === "string" && (o["error"] as string).length > 0);
      if (!refused) return null;
      const reason = o["reason"] ?? o["error"] ?? o["message"];
      return typeof reason === "string" && reason.length > 0 ? reason : "the action was refused by the vessel";
    };
    let action = await llmPickProducingAction(shape, siblings);
    if (!action) return null;
    // CONTENT-BINDING (action path): force the write body to the produced intermediate
    // findings (bindBody is defined at the top of this function and used on both paths).
    action = { shape: action.shape, args: bindBody(action.args) };
    let actionEp = await endpointForShape(action.shape);
    if (!actionEp) return null;
    let actionResult = await rawResolve(action.shape, actionEp.endpoint, actionEp.resolvePath, action.args);
    if (actionResult == null) return null; // action vessel rejected/empty → fall through
    // If the vessel soft-refused the args, retry ONCE with its reason as a correction.
    const refusal = refusalReason(actionResult);
    if (refusal) {
      console.log(`[goal-host-vessel] walk(${opts.surface}): satisfier action "${action.shape}" REFUSED (${refusal}) — retrying once with corrective feedback`);
      const retryAction = await llmPickProducingAction(shape, siblings, refusal);
      if (retryAction) {
        const retryEp = await endpointForShape(retryAction.shape);
        // Merge the first attempt's args UNDER the corrected ones: the retry often
        // only re-emits the field it was told to fix (e.g. path) and drops others
        // (e.g. content), which would write an empty artifact. Keep the original
        // content/body and let the corrected field win.
        const mergedArgs = bindBody(retryAction.shape === action.shape ? { ...action.args, ...retryAction.args } : retryAction.args);
        const retryResult = retryEp ? await rawResolve(retryAction.shape, retryEp.endpoint, retryEp.resolvePath, mergedArgs) : null;
        if (retryResult != null && !refusalReason(retryResult)) {
          action = { shape: retryAction.shape, args: mergedArgs }; actionEp = retryEp!; actionResult = retryResult;
        } else {
          // Still refused after correction — treat as genuine non-progress so the
          // walk falls through to the bridge/escalate path rather than producing a
          // refusal as if it were the asked artifact.
          return null;
        }
      } else {
        return null;
      }
    }
    console.log(`[goal-host-vessel] walk(${opts.surface}): satisfier action "${action.shape}" produced — re-reading target "${shape}"`);
    // Re-read the target now that the action ran; pass the action's args (e.g. path)
    // so the read targets the just-created artifact. Add the produced action shape
    // to the pool too (it's genuine output).
    addToPool(action.shape, actionResult, `vessel-resolve satisfier action (${action.shape})`);
    const reread = await rawResolve(shape, ep.endpoint, ep.resolvePath, { ...action.args, ...directArgs });
    if (reread != null) return { content: reread };
    // Action succeeded but re-read empty — still genuine progress (the artifact was
    // created). Surface the action result as the target's content rather than null,
    // so the walk advances and the reach-gate can judge the real artifact.
    return { content: actionResult };
  };

  // Goal impulse (shape "goal").
  addToPool("goal", { goal }, goal.slice(0, 200));
  // Seed any variable that looks like an impulse / carries a shape.
  for (const [k, v] of Object.entries(opts.variables ?? {})) {
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const shape =
        (o.metadata && typeof (o.metadata as Record<string, unknown>).shape === "string"
          ? ((o.metadata as Record<string, unknown>).shape as string)
          : undefined) ??
        (typeof o.shape === "string" ? (o.shape as string) : undefined);
      if (shape) {
        addToPool(shape, "content" in o ? o.content : o, `seed var ${k}`);
        continue;
      }
    }
    // Plain variable value — expose it as a named shape so a consumer declaring it can bind.
    addToPool(k, v, `seed var ${k}`);
  }

  const target = new Set<string>(opts.expectedOutputShapes ?? []);
  // With an explicit target, "met" = all target shapes produced. With NO target,
  // never short-circuit here — walk opportunistically (progress-driven), stopping
  // on MAX_STEPS or the consecutive-no-progress break below.
  const targetMet = (): boolean => target.size > 0 && [...target].every((s) => producedShapes.has(s));

  const chain: string[] = [];          // selected activity ids = the composition
  const chainExecIds: string[] = [...(opts.compositionChain ?? [])]; // recorded composition chain (execution ids)
  const exclude = new Set<string>();   // normalised activity ids already used / rejected
  let lastTrace: ExecutionTrace | null = null;
  let lastExecId: string | undefined = opts.parentExecutionId;
  let lastPick = "";
  let totalDurationMs = 0;
  let totalCostUsd = 0;
  let consecutiveNoProgress = 0;
  let earlyReachVerdict: GoalReachVerdict | null = null;
  let satisfierSeq = 0; // synthetic-trace id counter for vessel-resolve satisfier steps

  // ── 2-3. Walk the shape graph ──────────────────────────────────────────────
  while (chain.length < MAX_STEPS && !targetMet()) {
    // (0) VESSEL-RESOLVE SATISFIER — resolve-FIRST, before ANY candidate /
    //     horizontal-bundle / bridge-author step. When a missing target shape
    //     has a LIVE resolver advertised by a connected vessel, satisfy it by a
    //     REAL resolve call to that vessel and addToPool the genuine result, so
    //     the walk reaches the vessel's actual capability (e.g. obsidian
    //     write_note → a note really written) instead of selecting/authoring a
    //     hollow wrapper that "produces the shape" without doing the work.
    //     Strictly additive: a failed/empty resolve returns null and the walk
    //     proceeds to the unchanged candidate/bridge/escalate path below.
    if (target.size > 0) {
      const missingForSatisfier = [...target].filter((s) => !producedShapes.has(s));
      // DERIVATION DEFERRAL (composition, 2026-06-30): while ANY intermediate
      // (non-terminal) target shape is still unproduced, DO NOT satisfy a terminal
      // emit target yet — the terminal write must consume the intermediate's
      // produced content (real findings), not be written prematurely from goal text
      // (which is what made the prior composed note HOLLOW). No-op when terminalShapes
      // is empty (the common single-shape case): every shape passes the filter.
      const intermediatesPending = terminalShapes.size > 0 &&
        missingForSatisfier.some((s) => !terminalShapes.has(s));
      const eligibleForSatisfier = intermediatesPending
        ? missingForSatisfier.filter((s) => !terminalShapes.has(s))
        : missingForSatisfier;
      const liveForSatisfier = await liveShapes();
      const satisfiableNow = eligibleForSatisfier.find((s) => liveForSatisfier.has(s) && !satisfierTried.has(s) && !minted.has(s));
      if (satisfiableNow) {
        const resolved = await vesselResolveShape(satisfiableNow);
        if (resolved) {
          addToPool(satisfiableNow, resolved.content, `vessel-resolve satisfier (${satisfiableNow})`);
          // Record the satisfier as a GENUINE step: synthesize a minimal
          // ExecutionTrace so the walk's downstream accounting (chain.length > 0 →
          // reach-gate runs; attempts > 0 → caller does NOT fall to the recovery
          // loop) treats a real vessel-resolve exactly like a template execution.
          // The trace's task outputs the produced shape so the trace-sink and
          // reach-gate see what was actually produced; the reach-gate's content
          // digest already folds the full pool (incl. this shape's content).
          const satId = `satisfier:${satisfiableNow}`;
          const synthTrace: ExecutionTrace = {
            id: `walk-satisfier-${++satisfierSeq}-${Date.now()}`,
            templateId: satId,
            templateName: `vessel-resolve satisfier (${satisfiableNow})`,
            status: "completed",
            parentExecutionId: lastExecId,
            compositionChain: [...chainExecIds],
            inputImpulseIds: [],
            outputImpulseIds: [],
            tasks: [{
              taskId: "satisfier-resolve",
              description: `resolve ${satisfiableNow} via connected vessel`,
              resolverId: satisfiableNow,
              resolverTier: "pattern",
              inputImpulseIds: [],
              outputImpulseIds: [],
              outputShapes: [satisfiableNow],
              success: true,
            }],
            costUsd: 0,
            durationMs: 0,
            tags: opts.tags,
            metadata: { satisfier: true, shape: satisfiableNow },
          };
          chain.push(satId);
          exclude.add(normActivityId(satId));
          chainExecIds.push(synthTrace.id);
          lastTrace = synthTrace;
          lastExecId = synthTrace.id;
          lastPick = satId;
          tap(`[goal-host-vessel] walk(${opts.surface}): VESSEL-RESOLVE SATISFIER produced "${satisfiableNow}" directly (connected vessel resolve) — no bridge needed`);
          consecutiveNoProgress = 0;
          continue; // shape is now in the pool; re-evaluate target/candidates
        }
        console.log(`[goal-host-vessel] walk(${opts.surface}): vessel-resolve satisfier for "${satisfiableNow}" returned no content — proceeding to candidate/bridge path`);
      }
    }
    // (a) CANDIDATE GENERATION — shape-driven: consumers of the current pool.
    let candidates: WalkCandidate[] = [];
    try {
      const _sig1 = (await getCachedStateSignature())?.signature_hash;
      const r = await fetch(`${PRODUCER_DISCOVERY_ENDPOINT}/v2/activities/discover-by-shapes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
        body: JSON.stringify({ required_shapes: [...producedShapes], mode: "backward", limit: 50, ...((await getCachedStateSignature())?.signature_hash ? { state_signature: (await getCachedStateSignature())?.signature_hash } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) {
        const j: any = await r.json();
        const rows = j?.activities ?? j?.matches ?? j?.body?.activities ?? j?.results ?? [];
        candidates = (Array.isArray(rows) ? rows : [])
          .map(readCandidateShapes)
          .filter((c): c is WalkCandidate => c !== null && !exclude.has(normActivityId(c.id)) && !chain.includes(c.id));
      }
    } catch { /* discover failed — candidates stays empty */ }
    // Secondary: if discover surfaced nothing, fall back to the recommend ranker.
    if (candidates.length === 0) {
      try {
        const r = await fetch(`${ACTIVITY_API_ENDPOINT}/v2/activities/recommend`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
          body: JSON.stringify({ task_description: goal, goal, impulse_shapes: [...producedShapes], expected_output_shapes: [...target], exclude_activities: chain, limit: 12, min_success_rate: 0, ...((await getCachedStateSignature())?.signature_hash ? { state_signature: (await getCachedStateSignature())!.signature_hash } : {}) }),
          signal: AbortSignal.timeout(20_000),
        });
        if (r.ok) {
          const j: any = await r.json();
          const recs = j?.recommendations ?? j?.body?.recommendations ?? [];
          candidates = (Array.isArray(recs) ? recs : [])
            .map(readCandidateShapes)
            .filter((c): c is WalkCandidate => c !== null && !exclude.has(normActivityId(c.id)) && !chain.includes(c.id));
        }
      } catch { /* recommend failed too */ }
    }

    // (b) SELECT BEST — goal-gap weighted. With a target, prefer candidates that
    // advance TOWARD it; do NOT grab unrelated progress-makers (that wanders into
    // junk and starves the backward-chain/mint path). Without a target, walk
    // opportunistically (any forward progress).
    const missingTargetsB = [...target].filter((s) => !producedShapes.has(s));
    const makesProgress = (c: WalkCandidate): boolean =>
      c.outputShapes.some((s) => s !== "activityExecutionSummary" && !producedShapes.has(s));
    const advancesTarget = (c: WalkCandidate): boolean =>
      c.outputShapes.some((s) => missingTargetsB.includes(s));
    const inputsSatisfied = (c: WalkCandidate): boolean =>
      c.inputShapes.length > 0 && c.inputShapes.every((s) => producedShapes.has(s));
    const notScaffold = (c: WalkCandidate): boolean =>
      !(c.outputShapes.length === 1 && c.outputShapes[0] === "activityExecutionSummary");

    // Hollow-scaffold id families (compose wrappers, proposed-pattern autodrafts,
    // learned-tick clones, repaired autodrafts, and chained X-to-Y bridges) shape-
    // match a target but do no genuine work and get reach-gate-β-penalised. A target
    // with a LIVE resolver can be bridge-authored fresh (genuine work), so we must
    // NOT settle for a hollow scaffold of it. Note: a bare live-resolver wrapper like
    // `auto-bridge-code_quality` (no `-to-` chaining) IS a genuine producer and is
    // deliberately NOT matched here.
    const isHollowScaffold = (id: string): boolean => {
      const n = normActivityId(id);
      return /^(compose-|learned-compose|proposed_pattern_authored_|repaired-)/.test(n)
        || /-to-/.test(n); // chained composite bridge = hollow scaffold
    };
    // Genuine-first ranking key: genuine producers rank 0, hollow scaffolds rank 1.
    // Stable-sorting candidates by this key floats real producers ahead of the
    // ~581 compose-*/learned-*/proposed_*/repaired-*/X-to-Y scaffolds that shape-
    // match a target but produce 0 new shapes when run.
    const scaffoldRank = (c: WalkCandidate): number => (isHollowScaffold(c.id) ? 1 : 0);
    const liveSetB = target.size > 0 ? await liveShapes() : new Set<string>();
    const bridgeableTarget = (c: WalkCandidate): boolean =>
      c.outputShapes.some((s) => missingTargetsB.includes(s) && liveSetB.has(s));

    // (b.horizontal) HORIZONTAL COMPOSITION — OR-edge / parallel-and-join
    // (SUBSTRATE_AS_MDP §7). The single-pick path below composes VERTICALLY: one
    // producer per step, depth-first, which lands on hollow scaffolds when many
    // activities shape-match the same missing target. When >=2 currently-EXECUTABLE
    // genuine producers of the SAME missing shape T exist (an OR-edge), dispatch
    // them ALL in parallel as siblings under the shared parent, join their
    // GENUINELY-produced output shapes into the pool by shape-union, and let the
    // genuine producer win (hollow ones fail tasks / get reach-gate-β-penalised).
    // Bonus: √k posterior speedup + OR-edge discovery for the composition graph.
    // CREDIT CAVEAT: sibling credit should AVERAGE not sum at the shared ancestor
    // (γ^k·(1/k)Σr_i) so a k-wide bundle doesn't k-fold-inflate the parent's
    // posterior — that is an activity-api propagateCreditAlongChain change and is
    // OUT OF SCOPE here (this branch only fans out execution + joins by shape).
    if (target.size > 0) {
      const missing = [...target].filter((s) => !producedShapes.has(s));
      const T = missing[0];
      // The OR-edge = the PRODUCERS of T (forward discovery), unioned with any
      // backward candidates that also produce T. Filter to currently-executable
      // (inputs ⊆ pool), non-scaffold producers.
      let orEdge: WalkCandidate[] = [];
      if (T) {
        let forward: WalkCandidate[] = [];
        try {
          const r = await fetch(`${PRODUCER_DISCOVERY_ENDPOINT}/v2/activities/discover-by-shapes`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
            body: JSON.stringify({ required_shapes: [T], mode: "forward", limit: 50 }),
            signal: AbortSignal.timeout(20_000),
          });
          if (r.ok) {
            const j: any = await r.json();
            const rows = j?.activities ?? j?.matches ?? j?.body?.activities ?? j?.results ?? [];
            forward = (Array.isArray(rows) ? rows : []).map(readCandidateShapes).filter((c): c is WalkCandidate => c !== null);
          }
        } catch { /* discover failed */ }
        const seen = new Set<string>();
        orEdge = [...candidates, ...forward].filter((c) => {
          const id = normActivityId(c.id);
          if (seen.has(id) || exclude.has(id) || chain.includes(c.id)) return false;
          seen.add(id);
          return notScaffold(c) && c.outputShapes.includes(T) && (c.inputShapes.length === 0 || c.inputShapes.every((s) => producedShapes.has(s)));
        })
        // GENUINE-FIRST: float real producers ahead of hollow scaffolds so the
        // K-wide bundle spends its fan-out on producers that actually produce T
        // (discovery returns scaffolds first; without this the bundle is all
        // scaffolds → 0 new shapes → 2 no-progress steps → stop, never reaching).
        .sort((a, b) => scaffoldRank(a) - scaffoldRank(b));
      }
      // Fire the horizontal bundle only when >=2 GENUINE producers exist; a bundle
      // of pure scaffolds does no real work — fall through to the single-pick path
      // (which bridge-authors / backward-chains a genuine producer instead).
      const genuineOrEdge = orEdge.filter((c) => !isHollowScaffold(c.id));
      if (genuineOrEdge.length >= 2) {
        const K = Math.min(orEdge.length, parseInt(process.env.GOAL_HOST_HORIZONTAL_K ?? "4", 10));
        const bundle = orEdge.slice(0, K);
        const bundleParentExecId = lastExecId;
        // Fan out: run each producer of T as a sibling (SAME parent/chain). Per-branch
        // try/catch so one failure (incl. unfetchable template) doesn't abort the bundle.
        const branchResults = await Promise.all(
          bundle.map(async (c): Promise<ExecutionTrace | null> => {
            try {
              const tmpl = await getTemplateLocalFirst(c.id);
              if (!tmpl) return null;
              const bvars = poolVars();
              return await host.runTemplate(tmpl, bvars, {
                impulses: poolImpulses,
                parentExecutionId: bundleParentExecId,
                compositionChain: chainExecIds,
                variables: bvars,
                tags: opts.tags,
                goalContext: { goal },
              });
            } catch (e) {
              console.warn(`[goal-host-vessel] walk(${opts.surface}): HORIZONTAL branch ${c.id} threw: ${(e as Error).message}`);
              return null;
            }
          }),
        );
        // JOIN by shape-union: pull genuinely-produced shapes from SUCCESSFUL tasks
        // of every successful branch into the pool. Record every executed branch.
        const beforeBundle = producedShapes.size;
        let producedCount = 0;
        let bestTrace: ExecutionTrace | null = null;
        let bestExecId: string | undefined;
        let bestPickId: string | undefined;
        for (let i = 0; i < bundle.length; i++) {
          const c = bundle[i];
          const t = branchResults[i];
          chain.push(c.id);
          exclude.add(normActivityId(c.id));
          if (!t) continue;
          if (t.id) chainExecIds.push(t.id);
          totalDurationMs += t.durationMs ?? 0;
          totalCostUsd += t.costUsd ?? 0;
          const branchShapes = [...new Set(
            (t.tasks ?? [])
              .filter((tk) => (tk as { success?: boolean }).success !== false)
              .flatMap((tk) => tk.outputShapes ?? []),
          )].filter((s) => s && s !== "activityExecutionSummary");
          let branchProducedNew = false;
          let branchProducedT = false;
          for (const s of branchShapes) {
            if (!producedShapes.has(s)) branchProducedNew = true;
            if (s === T) branchProducedT = true;
            addToPool(s, { producedBy: c.id, executionId: t.id }, `produced by ${c.id} (horizontal)`);
          }
          if (branchProducedNew) producedCount++;
          // The genuine producer of T wins as the step's representative trace.
          if (t.status !== "failed" && (bestTrace === null || branchProducedT)) {
            bestTrace = t;
            bestExecId = t.id;
            bestPickId = c.id;
          }
        }
        if (bestTrace) {
          lastTrace = bestTrace;
          lastExecId = bestExecId;
          if (bestPickId) lastPick = bestPickId;
        }
        console.log(`[goal-host-vessel] walk(${opts.surface}): HORIZONTAL bundle for "${T}" — ran ${K} producers in parallel, ${producedCount} produced new shapes (OR-edge discovery)`);
        const progressed = producedShapes.size > beforeBundle;
        if (!progressed) {
          consecutiveNoProgress++;
          if (consecutiveNoProgress >= 2) {
            console.log(`[goal-host-vessel] walk(${opts.surface}): 2 consecutive no-progress steps — stopping`);
            break;
          }
        } else {
          consecutiveNoProgress = 0;
        }
        continue; // the bundle WAS this step's progress; skip the single-pick path
      }
    }

    let pick: WalkCandidate | undefined;
    if (target.size > 0) {
      const feasibleProducer = (c: WalkCandidate): boolean =>
        notScaffold(c) && advancesTarget(c) && (c.inputShapes.length === 0 || c.inputShapes.every((s) => producedShapes.has(s)));
      // 1. A GENUINE (non-hollow-scaffold) feasible producer of a target shape.
      pick = candidates.find((c) => feasibleProducer(c) && !isHollowScaffold(c.id))
        // 2. A scaffold producer is acceptable ONLY for a target with no live
        //    resolver (not bridge-authorable) — otherwise prefer bridge-authoring.
        ?? candidates.find((c) => feasibleProducer(c) && !bridgeableTarget(c));
      // RECURSE: if the only target-producers have UNSATISFIED inputs, produce
      // those inputs first (add as sub-targets) rather than executing the
      // producer prematurely — this is how the chain is built backward.
      if (!pick) {
        const needsInputs = candidates.find((c) => notScaffold(c) && advancesTarget(c) && c.inputShapes.length > 0);
        if (needsInputs) {
          let added = false;
          for (const s of needsInputs.inputShapes) if (!producedShapes.has(s) && !target.has(s)) { target.add(s); added = true; }
          if (added) {
            console.log(`[goal-host-vessel] walk(${opts.surface}): recurse — ${normActivityId(needsInputs.id)} needs [${needsInputs.inputShapes.join(",")}]; producing inputs first`);
            continue; // loop to produce the sub-target inputs, then re-pick this producer
          }
        }
      }
    } else {
      // Opportunistic: any genuine forward progress.
      pick = candidates.find((c) => notScaffold(c) && inputsSatisfied(c) && makesProgress(c))
        ?? candidates.find((c) => notScaffold(c) && makesProgress(c));
    }

    // (c) BACKWARD-CHAIN — find a producer of a missing target shape.
    if (!pick) {
      const missingTargets = [...target].filter((s) => !producedShapes.has(s));
      if (missingTargets.length > 0) {
        try {
          const _sig2 = (await getCachedStateSignature())?.signature_hash;
          const r = await fetch(`${PRODUCER_DISCOVERY_ENDPOINT}/v2/activities/discover-by-shapes`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
            body: JSON.stringify({ required_shapes: missingTargets, mode: "forward", limit: 50, ...(_sig2 ? { state_signature: _sig2 } : {}) }),
            signal: AbortSignal.timeout(20_000),
          });
          if (r.ok) {
            const j: any = await r.json();
            const rows = j?.activities ?? j?.matches ?? j?.body?.activities ?? j?.results ?? [];
            const producers = (Array.isArray(rows) ? rows : [])
              .map(readCandidateShapes)
              .filter((c): c is WalkCandidate => c !== null && !exclude.has(normActivityId(c.id)) && !chain.includes(c.id))
              // Drop hollow scaffolds for bridge-authorable targets so the walk
              // bridge-authors a genuine producer instead of reusing a scaffold.
              .filter((c) => !(isHollowScaffold(c.id) && bridgeableTarget(c)));
            // Prefer a GENUINE producer whose inputs are already satisfied (executable now).
            pick = producers.find((c) => !isHollowScaffold(c.id) && (c.inputShapes.length === 0 || c.inputShapes.every((s) => producedShapes.has(s))))
              ?? producers.find((c) => c.inputShapes.length === 0 || c.inputShapes.every((s) => producedShapes.has(s)));
            // BACKWARD-CHAIN RECURSION: no executable producer, but a producer with
            // UNSATISFIED inputs exists → produce its inputs first (add as sub-
            // targets), don't execute it prematurely. This turns the goal target
            // into a backward-built chain of producers (link_b←link_a, etc.).
            if (!pick) {
              const needsInputs = producers.find((c) => c.inputShapes.length > 0);
              if (needsInputs) {
                let added = false;
                for (const s of needsInputs.inputShapes) if (!producedShapes.has(s) && !target.has(s)) { target.add(s); added = true; }
                if (added) {
                  console.log(`[goal-host-vessel] walk(${opts.surface}): backward-chain — ${normActivityId(needsInputs.id)} needs [${needsInputs.inputShapes.join(",")}]; producing inputs first`);
                  continue;
                }
              }
            }
          }
        } catch { /* discover failed */ }
      }
    }

    // (c.2) MINT-AS-YOU-GO — Reserve Improvisation. Backward-chain found no
    //       producer for a missing target shape. If the substrate has a LIVE
    //       resolver for that shape, mint a thin wrapper activity around it so
    //       the walk can genuinely produce the shape this iteration. Only true
    //       capability gaps (no live resolver) fall through to escalate/stop.
    if (!pick && target.size > 0) {
      const missingTargets = [...target].filter((s) => !producedShapes.has(s));
      const live = await liveShapes();
      const X = missingTargets.find((s) => live.has(s) && !minted.has(s));
      if (X) {
        minted.add(X);
        // BRIDGE-AUTHOR: author a GENUINELY-PRODUCING invocation of X's resolver
        // (author→validate→refine via the resolver's own errors), returning a
        // validated producer + the input shapes it needs.
        let authored: { id: string; inputShapes: string[] } | null = null;
        try {
          const r = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
            body: JSON.stringify({ impulse: { type: "author_producer", pointer: { type: "author_producer", shape: X, goal, available_shapes: [...producedShapes], max_attempts: 3 } } }),
            signal: AbortSignal.timeout(180_000),
          });
          if (r.ok) {
            const j: any = await r.json();
            const b = j?.body ?? j;
            if (b?.minted_activity_id && b?.validated) {
              authored = { id: String(b.minted_activity_id), inputShapes: Array.isArray(b.input_shapes) ? b.input_shapes.map(String) : [] };
            }
          }
        } catch { /* author failed → falls through to escalate/stop */ }
        if (authored) {
          tap(`[goal-host-vessel] walk(${opts.surface}): BRIDGE-AUTHORED validated producer for "${X}" → ${authored.id} (inputs=[${authored.inputShapes.join(",")}])`);
          // Recurse: add the producer's missing inputs as sub-targets so the walk
          // produces them FIRST — mint-as-you-go builds the chain backward from
          // the goal toward what the pool already has.
          for (const s of authored.inputShapes) if (!producedShapes.has(s)) target.add(s);
          if (authored.inputShapes.every((s) => producedShapes.has(s))) {
            pick = { id: authored.id, inputShapes: authored.inputShapes, outputShapes: [X] };
          } else {
            continue; // produce the sub-target inputs first; re-discover this producer when ready
          }
        }
      }
    }

    if (!pick) {
      // LEAF→AUTHORING ESCALATION: a target shape has no producer and no live
      // resolver to bridge (true capability gap). File a scope-narrowed
      // substrateGap so the gap_to_feature → feature_compose → mitosis pipeline
      // authors the missing producer; a re-dispatch then reaches the goal.
      const missingNow = [...target].filter((s) => !producedShapes.has(s));
      let filedGap: string | null = null;
      if (missingNow.length > 0) {
        const liveNow = await liveShapes();
        const codeGap = missingNow.find((s) => !liveNow.has(s)); // true capability gap: no live resolver to bridge
        if (codeGap) filedGap = await fileCapabilityGap(codeGap, goal, missingNow);
        // REACHABILITY SELF-REPORT (priority #2): no codeGap means every missing target is advertised but not cold-reachable — self-report instead of stopping silently.
        else filedGap = await fileReachabilityGap(missingNow[0], goal, missingNow);
      }
      // REACHABILITY SELF-REPORT (priority #2, 2026-07-03): a 0-step walk whose missing
      // targets are all advertised (no capability gap filed) means a producer EXISTS but
      // is not cold-reachable. Emit an observable substrateGap instead of stopping
      // silently — the mismatched producer self-reports (canonical fix: optional_input_shapes).
      if (chain.length === 0 && !filedGap && missingNow.length > 0) {
        filedGap = await fileReachabilityGap(missingNow[0], goal, missingNow);
      }
      console.log(`[goal-host-vessel] walk(${opts.surface}): no shape-feasible step at chain.length=${chain.length} (producedShapes=${producedShapes.size}, missingTargets=${missingNow.length}) — ${filedGap ? `filed capability gap '${filedGap}' for "${missingNow[0]}" (authoring escalation)` : "escalating (stop)"}`);
      break;
    }

    // (d) EXECUTE the pick SEEDED WITH THE POOL — fetch the template by id, run it
    //     with the accumulated pool impulses + thread parent/composition ids so the
    //     steps form a recorded chain.
    let template: ActivityTemplate | null = null;
    try {
      template = await getTemplateLocalFirst(pick.id);
    } catch (e) {
      console.warn(`[goal-host-vessel] walk(${opts.surface}): getTemplate(${pick.id}) failed: ${(e as Error).message}`);
    }
    if (!template) {
      // Can't fetch the template object — exclude and try another candidate.
      exclude.add(normActivityId(pick.id));
      console.log(`[goal-host-vessel] walk(${opts.surface}): template ${pick.id} unfetchable — excluding`);
      continue;
    }

    let trace: ExecutionTrace;
    try {
      const bvars = poolVars();
      trace = await host.runTemplate(template, bvars, {
        impulses: poolImpulses,
        parentExecutionId: lastExecId,
        compositionChain: chainExecIds,
        variables: bvars,
        tags: opts.tags,
        goalContext: { goal },
      });
    } catch (e) {
      exclude.add(normActivityId(pick.id));
      console.warn(`[goal-host-vessel] walk(${opts.surface}): runTemplate(${pick.id}) threw: ${(e as Error).message} — excluding`);
      continue;
    }
    lastTrace = trace;
    lastPick = pick.id;
    lastExecId = trace.id;
    if (trace.id) chainExecIds.push(trace.id);
    totalDurationMs += trace.durationMs ?? 0;
    totalCostUsd += trace.costUsd ?? 0;

    // (e) MERGE OUTPUTS — pull genuinely-new shapes from the trace tasks into the pool.
    const beforeSize = producedShapes.size;
    // Advance the pool ONLY by shapes the activity GENUINELY produced — actual
    // output shapes from SUCCESSFUL tasks of this execution. No optimistic
    // declared-shape advancement: a composition step counts only if the data was
    // really produced, so the reach-gate judges genuine artifacts, not promises.
    // Bind REAL produced content into the pool — not a metadata stub. A walk
    // step's output impulses survive in the shared ImpulseStore (declared
    // outputs are kept across nested executions, read via runtime.store.get),
    // so the genuine artifact (e.g. problem_detection's actual problems) flows
    // into the NEXT step's `{{shape}}` binding instead of `{producedBy,
    // executionId}`. Without this, every cross-vessel chain is judged HOLLOW
    // because the consumer only ever sees the producer's metadata, not its data.
    const store = (host as { runtime?: { store?: { get(id: string): { content?: unknown; metadata?: { shape?: string } } | undefined } } }).runtime?.store;
    for (const t of (trace.tasks ?? [])) {
      if ((t as { success?: boolean }).success === false) continue;
      const outIds = (t as { outputImpulseIds?: string[] }).outputImpulseIds ?? [];
      // Prefer real content keyed by the impulse's ACTUAL shape.
      for (const id of outIds) {
        const imp = store?.get(id);
        if (!imp) continue;
        const shape = imp.metadata?.shape;
        if (!shape || shape === "activityExecutionSummary") continue;
        if (imp.content === undefined || imp.content === null) continue;
        addToPool(shape, imp.content, `produced by ${pick.id}`);
      }
      // Fallback: declared output shapes whose content we could not recover
      // still advance reachability (keep the walk progressing) as a stub.
      for (const s of (t.outputShapes ?? [])) {
        if (s && s !== "activityExecutionSummary" && !producedShapes.has(s)) {
          addToPool(s, { producedBy: pick.id, executionId: trace.id }, `produced by ${pick.id} (stub)`);
        }
      }
    }
    chain.push(pick.id);
    exclude.add(normActivityId(pick.id));
    const progressed = producedShapes.size > beforeSize;
    tap(`[goal-host-vessel] walk(${opts.surface}): step ${chain.length} ran ${pick.id} status=${trace.status} new_shapes=${producedShapes.size - beforeSize} pool=${producedShapes.size} chain=${chainExecIds.length}`);
    if (!progressed) {
      consecutiveNoProgress++;
      if (consecutiveNoProgress >= 2) {
        console.log(`[goal-host-vessel] walk(${opts.surface}): 2 consecutive no-progress steps — stopping`);
        break;
      }
    } else {
      consecutiveNoProgress = 0;
      // Incremental reach-check (2026-06-25): judge reach NOW, while the just-
      // produced — and, for a sense-back bridge, freshly SENSED — evidence is at
      // the front of the pool, and STOP before the walk wanders into no-progress
      // steps whose errors (e.g. code-analysis ENOENT on a written note) pollute
      // the pool and fool the end-of-walk gate into a false HOLLOW. Only runs on a
      // step that produced something. Reaching goals stop early (cheaper); non-
      // reaching goals pay one extra judge per progressed step.
      // The pool holds provenance STUBS ({producedBy,executionId}) for a nested
      // bridge's internal task outputs (the walk store can't recover them). The
      // REAL content was snapshotted at emit time into reachContentDigests keyed
      // by execId — fold the just-run step's captured digest in FIRST so the
      // judge sees genuine artifacts (the written + sensed note), not stubs. (2026-06-25)
      const interimCaptured = (lastExecId && reachContentDigests.get(lastExecId)) || "";
      const interimPool = poolImpulses
        .filter((imp) => { const s = (imp.metadata as { shape?: string } | undefined)?.shape; return s && s !== "goal"; })
        .map((imp) => {
          const s = (imp.metadata as { shape?: string } | undefined)?.shape ?? "?";
          let c: string;
          try { c = typeof imp.content === "string" ? imp.content : JSON.stringify(imp.content); } catch { c = String(imp.content); }
          return `- ${s}: ${c.slice(0, 1500)}`;
        })
        .join("\n");
      const interimDigest = [interimCaptured, interimPool].filter(Boolean).join("\n").slice(0, 8000);
      try {
        const interim = await verifyGoalReached(
          goal,
          [...producedShapes],
          `walk(${chain.length} steps): ${chain.map(normActivityId).join(" → ")}`,
          interimDigest || undefined,
        );
        if (interim && interim.reached === true) {
          earlyReachVerdict = interim;
          console.log(`[goal-host-vessel] walk(${opts.surface}): REACHED early at step ${chain.length} — stopping before pollution. completion_shapes=${JSON.stringify(interim.completion_shapes)}`);
          break;
        }
      } catch (e) {
        console.warn(`[goal-host-vessel] walk incremental reach-check error (non-fatal): ${(e as Error).message}`);
      }
    }
  }

  // ── 4. Reach gate + per-goal record + reach→mint (reuse existing logic) ──────
  let status: "failed" | "completed" = lastTrace && lastTrace.status !== "failed" ? "completed" : "failed";
  let completionShapes: string[] | null = null;
  let goalReachReason: string | undefined;
  let reached = false;

  if (lastTrace && chain.length > 0) {
    const chainSummary = `walk(${chain.length} steps): ${chain.map(normActivityId).join(" → ")}`;
    // Content digest: let the reach-gate judge from ACTUAL produced content, not
    // just shape names (2026-06-24). Without this a genuine content-bearing output
    // (e.g. problem_detection with real problems) is indistinguishable from a hollow
    // shape-emitter, so the LLM verifier rejects genuine work non-deterministically.
    // Prefer the emit-time captured digest of the LAST step's real outputs (the
    // step that should have reached the goal); fall back to the running pool.
    const capturedDigest = (lastExecId && reachContentDigests.get(lastExecId)) || "";
    // The walk frequently continues PAST the goal-reaching step into no-progress
    // junk steps, so the LAST step's captured digest is NOT necessarily the
    // goal-bearing one (e.g. a goal answered by code_quality at step 1, then the
    // walk wanders into an inert problem_detection at step 4 whose empty output
    // became the captured digest). Always fold in the FULL accumulated pool — all
    // content-bearing shapes — so a goal-satisfying output produced at an earlier
    // step is visible to the reach-gate, not just the terminal task's output. Pool
    // content goes first so substantive earlier outputs survive the length cap.
    // (2026-06-24)
    const poolDigest = poolImpulses
      .filter((imp) => { const s = (imp.metadata as { shape?: string } | undefined)?.shape; return s && s !== "goal"; })
      .map((imp) => {
        const s = (imp.metadata as { shape?: string } | undefined)?.shape ?? "?";
        let c: string;
        try { c = typeof imp.content === "string" ? imp.content : JSON.stringify(imp.content); } catch { c = String(imp.content); }
        return `- ${s}: ${c.slice(0, 1500)}`;
      })
      .join("\n");
    // Caps sized so a real content-bearing output (e.g. a code_annotation list of
    // functions+line-numbers, or code_quality metrics) survives intact for the LLM
    // judge — the shape-name-era 600/4000 caps truncated list outputs mid-content,
    // making the gate report "content not shown" on genuinely-reached goals.
    const contentDigest = [poolDigest, capturedDigest].filter(Boolean).join("\n").slice(0, 8000);
    try {
      // Honour an early reach verdict captured mid-walk (before pollution) instead
      // of re-judging the now-polluted end-state pool. (2026-06-25)
      const verdict = earlyReachVerdict
        ?? await verifyGoalReached(goal, [...producedShapes], chainSummary, contentDigest || undefined);
      completionShapes = verdict?.completion_shapes ?? null;
      reached = verdict?.reached !== false;
      if (verdict && verdict.reached === false) {
        status = "failed";
        goalReachReason = verdict.reason;
        await penaliseHollowTemplate(lastPick, verdict.reason ?? "goal not reached");
        tap(`[goal-host-vessel] walk(${opts.surface}): HOLLOW — ${verdict.reason}; β-penalised last pick ${lastPick}. completion_shapes=${JSON.stringify(verdict.completion_shapes)}`);
        // LEAF→AUTHORING ESCALATION (precise path): the reach-gate names the
        // shapes the goal needed but the walk could not produce. If any such
        // shape has NO live resolver (a true CAPABILITY gap — not a selection
        // miss a resolver could have served), file a scope-narrowed substrateGap
        // so gap_to_feature → feature_compose → mitosis authors the missing
        // producer; a re-dispatch then reaches the goal. This is the mechanism by
        // which capability EXPANDS on goal demand. (2026-06-25)
        try {
          const needed = [...new Set([...(verdict.missing ?? []), ...((verdict.completion_shapes ?? []).filter((s) => !producedShapes.has(s)))])].map(String).filter(Boolean);
          if (needed.length > 0) {
            const live = await liveShapes();
            const codeGap = needed.find((s) => !live.has(s));
            if (codeGap) {
              const gapId = await fileCapabilityGap(codeGap, goal, needed);
              if (gapId) console.log(`[goal-host-vessel] walk(${opts.surface}): filed capability gap '${gapId}' for missing shape "${codeGap}" (no live resolver) — authoring escalation`);
            }
          }
        } catch (e) { console.warn("[goal-host-vessel] capability-gap filing error (non-fatal):", (e as Error).message); }
      } else if (verdict && verdict.reached === true) {
        tap(`[goal-host-vessel] walk(${opts.surface}): REACHED via ${chain.length}-step chain. completion_shapes=${JSON.stringify(verdict.completion_shapes)}`);
        // Don't ribosome-mint a SINGLE satisfier trace: it's a synthetic one-task
        // record of a direct vessel resolve, not an extractable recipe — minting it
        // would write a hollow `satisfier:<shape>` template. The reached PATH is
        // still captured via recordGoalPath below (the useful learning signal).
        const satisfierOnly = (lastTrace.metadata as { satisfier?: boolean } | undefined)?.satisfier === true;
        // GENUINE MULTI-STEP COMPOSITION (2026-06-30): when the reached chain has
        // ≥2 steps — even if the final step is a satisfier (e.g. derive→emit:
        // problem_detection → obsidian:note, where BOTH steps are vessel-resolve
        // satisfiers) — that IS an extractable recipe (the composition flows real
        // intermediate content into the terminal write). Synthesize a COMPOSITE
        // trace from the whole chain and mint THAT, so a derive→emit composition
        // yields a fresh learned-* template (taskCount≥2), not nothing. A single
        // satisfier step alone is still skipped (no recipe to extract).
        if (!satisfierOnly) {
          void mintReachedTrace(lastTrace as any);
        } else if (chain.length >= 2) {
          const composite = buildCompositeTraceFromChain(chain, chainExecIds, [...producedShapes], totalDurationMs, totalCostUsd, opts.tags, poolImpulses);
          // Persist the composite so ribosome-extract can read it by id, then mint.
          void (async () => {
            try { await satisfierTraceSink.record(composite as unknown as ExecutionTrace); } catch { /* best-effort */ }
            await mintReachedTrace(composite as any);
          })();
        }
      }
      // DURABLE-TRACE persistence for satisfier reaches (2026-06-28). A satisfier
      // trace is synthetic (never ran through the engine), so the engine-internal
      // TranslatingTraceSink never persisted it and activity_execution_traces stayed
      // empty for outward reaches. Persist it HERE via the same sink, mirroring the
      // engine's template path: status reflects the REACH verdict (reached → the
      // trace's "completed" maps to success; not-reached → "failed" maps to a
      // "failure" trace so β accumulates honestly, exactly like template failures).
      // Best-effort + only for satisfier-only traces (engine already persisted real
      // template executions — guard against double-persist). (2026-06-28)
      const satisfierOnlyTrace = (lastTrace.metadata as { satisfier?: boolean } | undefined)?.satisfier === true;
      if (satisfierOnlyTrace) {
        const durableTrace: ExecutionTrace = {
          ...lastTrace,
          status: reached ? "completed" : "failed",
          reason: reached ? lastTrace.reason : (goalReachReason ?? lastTrace.reason),
        };
        void persistSatisfierTrace(durableTrace);
      }
    } catch (e) {
      console.warn("[goal-host-vessel] walk goal-reach verify error (non-fatal):", (e as Error).message);
    }
    // Per-goal learning: record the FULL multi-activity path -> reach outcome.
    void recordGoalPath(goal, chain, reached, totalDurationMs, totalCostUsd);
  }

  // Adapt the last ExecutionTrace into the GoalRunResult shape the callers read.
  const result = lastTrace
    ? ({ trace: lastTrace, selectedTemplateId: lastPick } as Awaited<ReturnType<typeof host.runGoal>>)
    : null;
  return {
    result,
    status,
    selectedTemplateId: chain.length > 0 ? chain[chain.length - 1] : undefined,
    completionShapes,
    attempts: chain.length,
    goalReachReason,
    reached,
  };
}

// SINGLE goal-seeking-with-recovery implementation shared by BOTH dispatch
// surfaces (async /run-goal + sync /resolve) — there must be exactly one copy of
// this logic, not a duplicate per surface that can drift. Recovery is part of
// reaching the goal, not a separate offline repair: try an approach → check reach
// (the gate) → on not-reached β-penalise + EXCLUDE that approach + re-recommend a
// DIFFERENT one → retry, until reached or approaches exhausted. The attempt that
// REACHES leaves a trace the ribosome mints into a new activity seed. Callers
// differ only in maxAttempts (sync /resolve is bounded by the MCP ~290s timeout;
// async /run-goal can recover more deeply) and in how they pass options. An
// explicit caller-pinned target is respected verbatim (no alteration).
async function runGoalWithRecovery(
  goal: string | undefined,
  opts: {
    firstTarget?: string;
    callerPinned?: boolean;
    maxAttempts: number;
    variables: Record<string, unknown>;
    tags?: string[];
    parentExecutionId?: string;
    compositionChain?: string[];
    expectedOutputShapes?: string[];
    surface: string;
    // AUTHOR FALLBACK (2026-06-29): when the walk takes 0 shape-feasible steps,
    // invoke this to LLM-author a from-scratch template and run THAT instead.
    // Deferred (not eager) so the shape-graph walk — including the vessel-resolve
    // satisfier that routes an outward read-capability goal (analysis / concept)
    // to its producing vessel — gets first crack. Previously /run-goal authored a
    // template BEFORE the walk and passed it as firstTarget, which suppressed the
    // walk entirely (a set firstTarget skips the walk block below) — so outward
    // analysis goals fell into slow from-scratch drafting and never reached
    // analysis-vessel. Returns the authored template id, or undefined if it didn't
    // author one (then the existing single-template recovery loop proceeds).
    authorFallback?: () => Promise<string | undefined>;
    /** Reason plane: caller-owned sink; goal-decomposition + walk decision lines pushed here. */
    stepSink?: string[];
  },
): Promise<GoalSeekResult> {
  // Reason-plane tap (outer): mirror goal-decomposition lines to the caller's sink.
  const tap = (m: string): void => { console.log(m); opts.stepSink?.push(m); };
  // DEFAULT strategy (2026-06-23): when there's a goal, the caller did NOT pin a
  // target, and no firstTarget is supplied, WALK THE SHAPE GRAPH across multiple
  // activities instead of picking one whole template by goal-text. Automatic
  // graceful fallback (NO flag): if the walk couldn't take even one shape-feasible
  // step (chain.length === 0), fall through to the single-template recovery loop
  // below. callerPinned / firstTarget / no-goal paths use the existing loop unchanged.
  // Holds an id authored by opts.authorFallback when the walk takes 0 steps, so
  // the single-template recovery loop below runs the freshly-authored template.
  let authoredFallbackTarget: string | undefined;
  if (goal && !opts.callerPinned && !opts.firstTarget) {
    // Lever 4 (2026-06-25): seed the walk's target from the goal. With no caller
    // expected_output_shapes and no pinned target, the walk would run OPPORTUNISTIC
    // and pick the highest-Thompson tick regardless of goal relevance. Infer the
    // goal-satisfying output shape(s) from the known producible vocabulary so the
    // walk backward-chains toward a capability-matched producer. Explicit caller
    // expected_output_shapes always wins (we only infer when it is empty). Fails
    // open to the current opportunistic behavior on inference-empty / LLM-down.
    let seededOutputShapes = opts.expectedOutputShapes;
    let knownShapes: string[] | null = null;
    if (!seededOutputShapes || seededOutputShapes.length === 0) {
      knownShapes = await fetchKnownShapes();
      const inferred = await inferGoalTargetShapes(goal, knownShapes, {
        llmEndpoint: LLM_VESSEL_ENDPOINT,
        cache: inferredTargetShapeCache,
      });
      tap(
        `[goal-host-vessel] ${opts.surface}: goal-target inference ` +
          JSON.stringify({ goal_hash: goalHashOf(goal), inferred_target_shapes: inferred }),
      );
      if (inferred.length > 0) seededOutputShapes = inferred;
    }
    // COMPOSITION (derivation-intent, 2026-06-30): when the goal is a derive→emit
    // SEQUENCE ("analyze X then write findings to note Y"), the seeded shapes above
    // are the TERMINAL emit targets. Infer the INTERMEDIATE shape(s) that must be
    // produced first (e.g. problem_detection) and PREPEND them so the walk produces
    // the analysis BEFORE the terminal write — and so the terminal write's content
    // is bound from the produced findings (deferral + content-binding live in the
    // walk's satisfier). Tight classifier returns [] for plain single-step goals →
    // unchanged 1-step behaviour. Only attempted when we have a terminal target set.
    let terminalOutputShapes: string[] | undefined;
    if (seededOutputShapes && seededOutputShapes.length >= 2) {
      // Partition the (multi-shape) target into derive→emit stages. No-op for a
      // single-shape target (the common case) — needs ≥2 shapes to be a derivation.
      const split = await inferDerivationSplit(goal, seededOutputShapes, {
        llmEndpoint: LLM_VESSEL_ENDPOINT,
        cache: inferredTargetShapeCache,
      });
      if (split.intermediate.length > 0 && split.terminal.length > 0) {
        // TERMINAL-WRITE RESOLVABILITY (composition capstone, 2026-06-30): the
        // inference vocabulary contains output-NAME shapes (e.g. fileWriteResult,
        // fileEditResult) that local-tools-vessel ADVERTISES but does NOT resolve —
        // its registry only knows the ACTION verbs (fs_write, fs_edit). A pointer
        // {type:"fileWriteResult"} therefore returns "no resolver for ...", the
        // terminal write silently drops, and the reach-gate judges the composed note
        // HOLLOW ("no evidence of the markdown note being written"). The goal here
        // asks to write a VAULT note (a "Substrate/…md" path / "note"), whose genuine,
        // resolvable, reach-verifiable write shape is obsidian:write_note. Remap any
        // unresolvable filesystem-write terminal to obsidian:write_note when (a) the
        // goal's write target is a vault note path and (b) obsidian:write_note is
        // actually resolvable in this substrate. Purely additive: a goal already
        // targeting obsidian:write_note never enters this branch with a dead fs shape,
        // and a non-note write target (real fs path) is left untouched.
        const UNRESOLVABLE_FS_WRITE = new Set(["fileWriteResult", "fileEditResult", "fs_write", "fs_edit"]);
        const wantsVaultNote = /substrate\/[^\s"']*\.md\b/i.test(goal) || /\bnotes?\b/i.test(goal);
        const obsidianWriteResolvable =
          shapeEndpointMap.has("obsidian:write_note") || discoveredProxyShapes.includes("obsidian:write_note");
        const remappedTerminal = split.terminal.map((s) =>
          UNRESOLVABLE_FS_WRITE.has(s) && wantsVaultNote && obsidianWriteResolvable ? "obsidian:write_note" : s,
        );
        // De-dup in case the goal already carried obsidian:write_note alongside the fs shape.
        terminalOutputShapes = [...new Set(remappedTerminal)];
        if (terminalOutputShapes.join() !== split.terminal.join()) {
          console.log(
            `[goal-host-vessel] ${opts.surface}: terminal-write remapped to resolvable vault writer ` +
              JSON.stringify({ goal_hash: goalHashOf(goal), from: split.terminal, to: terminalOutputShapes }),
          );
        }
        // Order intermediates first so the walk produces the analysis before the
        // deferred terminal write (the satisfier enforces the deferral too).
        seededOutputShapes = [...split.intermediate, ...terminalOutputShapes];
        tap(
          `[goal-host-vessel] ${opts.surface}: derivation-intent intermediates ` +
            JSON.stringify({ goal_hash: goalHashOf(goal), intermediate_shapes: split.intermediate, terminal_shapes: terminalOutputShapes }),
        );
      }
    }
    try {
      const walk = await runGoalAsPoolWalk(goal, {
        variables: opts.variables,
        tags: opts.tags,
        parentExecutionId: opts.parentExecutionId,
        compositionChain: opts.compositionChain,
        expectedOutputShapes: seededOutputShapes,
        terminalOutputShapes,
        surface: opts.surface,
        stepSink: opts.stepSink,
      });
      const editIntentGoal = process.env.ROUTE_EDIT_INTENT_TO_COMPOSE !== "0" && /repos\/[\w.-]+\/[\w.\/-]+\.\w+/.test(goal);
      // A >0-step walk that "reached" via a source_code / analysis READ satisfier does
      // NOT serve an edit-intent goal (read != edit) — this is how a code-edit goal got
      // hollow-satisfied as a source read, bypassing the edit-intent routing below. When
      // the goal names a repos source file with edit language AND the walk produced only
      // read/analysis shapes, fall through to edit-intent routing instead of returning.
      const goalIsEditIntent = /repos\/[\w.-]+\/[\w.\/-]+\.\w+/.test(goal) && /\b(edit|add|insert|append|prepend|change|modify|replace|fix|remove|delete|update|rename|refactor|wire|guard)\b/i.test(goal);
      const walkOnlyReadShapes = (walk.completionShapes ?? []).length > 0 && (walk.completionShapes ?? []).every((s) => ["source_code", "llm_completion_result", "error_log", "problem_detection", "code_quality", "code_annotation", "cpg_query_result"].includes(s));
      if (walk.attempts > 0 && !(goalIsEditIntent && walkOnlyReadShapes)) return walk;
      // EDIT-INTENT ROUTING (2026-07-02): a 0-step walk that NAMES a concrete source
      // file is a plain code-change goal the shape-walk cannot serve. Its only
      // fileEditResult producer is local-tools-vessel (a raw path+content writer,
      // unsatisfiable from prose), so the walk takes 0 steps, falls to recommend, and
      // picks an unrelated MAINTENANCE tick (reached:false). The real authoring
      // capability — feature_compose (a dev-vessel resolver: draft→typecheck→cutover)
      // — is only ever reached by explicit dispatch, never by the walk from intent.
      // Route edit-intent goals THERE before the recommend loop. Strictly additive +
      // guarded: fires ONLY on 0-step walks that name a repos/<vessel>/.../<file>.<ext>,
      // a case that ALWAYS fails into a tick today — no regression surface. Flag-off or
      // any throw falls through to the existing authorFallback/recommend path unchanged.
      if (process.env.ROUTE_EDIT_INTENT_TO_COMPOSE !== "0") {
        const fileMatch = goal.match(/repos\/([\w.-]+)\/[\w./-]+\.\w+/);
        if (fileMatch) {
          const editFile = fileMatch[0];
          const editVessel = fileMatch[1]!;
          // Carry a line reference from the goal TEXT into edit_site (2026-07-02):
          // dev-vessel's near-edit-site grounding parses ':<n>' / 'line <n>' from
          // edit_site; without it the excerpt defaults to top-of-file. Accept either
          // '<file>:<n>' immediately after the matched path or a 'line <n>' mention.
          const afterFile = goal.slice(goal.indexOf(editFile) + editFile.length);
          const editLine = afterFile.match(/^:(\d+)/)?.[1] ?? goal.match(/\bline\s+~?(\d+)/i)?.[1];
          const editSite = editLine ? `${editFile}:${editLine}` : editFile;
          try {
            tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT DETECTED (0-step walk names ${editFile}) — routing to feature_compose`);
            const spec = [
              "Make the SMALLEST concrete, verifiable code change to EXISTING vessel source that satisfies this development goal.",
              `Target file — EDIT IT IN PLACE: emit \`edit\` ops on this EXACT path only; do NOT create a new file, vessel, or package.json: ${editFile}`,
              "The change MUST typecheck.",
              "",
              `GOAL: ${goal}`,
            ].join("\n");
            const gapId = `route-edit-${goalHashOf(goal)}`;
            // Resolve the feature_compose producer via DISCOVERY first (impulse-contract
            // compliance: no hardcoded vessel endpoint). Same inline vesselCapability
            // idiom as endpointForShape / the proxy resolver above. dev-vessel does not
            // yet advertise feature_compose, so today this yields nothing and the env
            // fallback (DEV_VESSEL_ENDPOINT → 127.0.0.1:8090) carries. One lookup per
            // interception call; any discovery failure falls through silently.
            let composeUrl = `${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`;
            try {
              const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
                body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "feature_compose" } }),
                signal: AbortSignal.timeout(5_000),
              });
              const dj = await dr.json() as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string }> } };
              const v = dj?.content?.vessels?.[0];
              if (v?.endpoint) {
                composeUrl = `${v.endpoint.replace(/\/+$/, "")}${v.resolve_endpoint || "/resolve"}`;
                tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT feature_compose producer resolved via discovery → ${composeUrl}`);
              }
            } catch { /* discovery unreachable/empty → env fallback carries */ }
            const resp = await fetch(composeUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
              body: JSON.stringify({
                impulse: {
                  pointer: {
                    type: "feature_compose",
                    spec,
                    verify_vessels: [`repos/${editVessel}`],
                    land: true,
                    gap: {
                      id: gapId,
                      summary: goal,
                      category: "edit_intent_route",
                      classification_metadata: { edit_site: editSite },
                    },
                  },
                },
              }),
              signal: AbortSignal.timeout(240_000),
            });
            const j: any = await resp.json().catch(() => ({}));
            const body = (j?.body ?? j ?? {}) as Record<string, any>;
            const verdict = String(body.verdict ?? "");
            const cutovers = Array.isArray(body.cutovers) ? body.cutovers : [];
            let landedSha: string | null = null;
            for (const c of cutovers) {
              const rr = ((c ?? {}).result ?? {}) as Record<string, unknown>;
              if (rr.push_status === "pushed" && typeof rr.new_git_sha === "string" && rr.new_git_sha.trim()) {
                landedSha = rr.new_git_sha.trim();
                break;
              }
            }
            if (verdict === "FAVORABLE") {
              // Reason-plane: a reached routed dispatch should say WHAT was done, not
              // just that it landed — append the compose report's own summary.
              const summary = typeof body.summary === "string" && body.summary.trim()
                ? ` — ${body.summary.trim().slice(0, 160)}` : "";
              tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT ROUTED to feature_compose for ${editFile} → verdict=FAVORABLE${landedSha ? ` landed=${landedSha}` : " (staged)"}${summary}`);
              return {
                result: null,
                status: "completed",
                selectedTemplateId: "feature_compose",
                completionShapes: ["fileEditResult"],
                attempts: 1,
                goalReachReason: `routed edit-intent to feature_compose; ${landedSha ? `landed ${landedSha}` : "staged FAVORABLE"}${summary}`,
                reached: true,
                executionId: landedSha ? `feature_compose:${landedSha}` : undefined,
              };
            }
            // Reason-plane (GAP B): surface the WHY from the compose report instead of
            // dropping it. Preference order: first failed applied[] op's parsed detail
            // → semantic_gate.reason → body.error → explicit "no detail" marker.
            let failDetail = "";
            const applied = Array.isArray(body.applied) ? body.applied : [];
            const failedOp = applied.find((a: any) => a && a.ok === false);
            if (failedOp) {
              const rawDetail = typeof failedOp.detail === "string" ? failedOp.detail : JSON.stringify(failedOp.detail ?? "");
              let parsedErr = "";
              try { parsedErr = String(JSON.parse(rawDetail)?.error ?? ""); } catch { /* not JSON */ }
              failDetail = (parsedErr || rawDetail || "op failed with no detail").slice(0, 160);
            } else if (body.semantic_gate && typeof body.semantic_gate === "object" && typeof (body.semantic_gate as any).reason === "string" && (body.semantic_gate as any).reason.trim()) {
              failDetail = `semantic_gate: ${String((body.semantic_gate as any).reason).trim().slice(0, 200)}`;
            } else if (body.error) {
              failDetail = String(body.error).slice(0, 200);
            } else {
              failDetail = "no failure detail in compose report";
            }
            const flags = [
              body.apply_failed ? "apply_failed" : "",
              body.rolled_back ? "rolled_back" : "",
            ].filter(Boolean).join(", ");
            const failWhy = `op_count=${body.op_count ?? "?"}${flags ? `, ${flags}` : ""}: ${failDetail}`;
            tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT ROUTED to feature_compose for ${editFile} → verdict=${verdict || "(none)"} (${failWhy})`);
            return {
              result: null,
              status: "failed",
              selectedTemplateId: "feature_compose",
              completionShapes: null,
              attempts: 1,
              goalReachReason: `routed edit-intent to feature_compose; verdict=${verdict || "unknown"} (${failWhy})`,
              reached: false,
            };
          } catch (e) {
            tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT feature_compose call failed (${(e as Error).message}) — falling through to authorFallback/recommend`);
            // fall through to the existing behaviour unchanged
          }
        }
      }
      // ACTIVITY-REPAIR interception (2026-07-02): the activity analogue of the
      // edit-intent block above, one artifact level up. Vessels are maintained by
      // editing bytes (feature_compose); ACTIVITIES are maintained by minting
      // VARIANTS (template_repair → activity_create_variant; promotion stays with
      // the Thompson evidence gate). Without this, a 0-step walk on "fix the flaky
      // <id> activity" falls to recommend and grabs a keyword-similar maintenance
      // tick (proven mis-route). Same guarantees: flag-gated, additive, try-caught;
      // an id that turns out not to be a real template falls THROUGH unchanged, so
      // a false-positive match is harmless.
      // DEMOTED to break-glass (2026-07-03): the walk-native seed template
      // development-vessel:repair-activity-from-failures now reaches repair goals
      // in a 1-step chain (via the optional_input_shapes primitive), so this
      // hardcoded interception is redundant and defaults OFF. Set the env flag
      // ROUTE_ACTIVITY_REPAIR=1 to re-enable it as a fallback.
      if (process.env.ROUTE_ACTIVITY_REPAIR === "1" && !/repos\/[\w.-]+\//.test(goal)) {
        const actId =
          goal.match(/activity:⟨([^⟩]+)⟩/)?.[1] ??
          goal.match(/\b(?:activity|template)\s+[`"'‘’]?([a-z0-9][\w-]*(?::[\w-]+)+|[a-z0-9][\w-]*-[\w-]{2,})/i)?.[1] ??
          goal.match(/[`"'‘’]?([a-z0-9][\w-]*(?::[\w-]+)+|[a-z0-9][\w-]*-[\w-]{2,})[`"'‘’]?\s+(?:activity|template)\b/i)?.[1];
        if (actId) {
          try {
            tap(`[goal-host-vessel] ${opts.surface}: ACTIVITY-REPAIR DETECTED (0-step walk names activity "${actId}") — routing to template_repair`);
            // Discovery-first producer resolution, same idiom as feature_compose above.
            let repairUrl = `${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`;
            try {
              const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
                body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "template_repair" } }),
                signal: AbortSignal.timeout(5_000),
              });
              const dj = await dr.json() as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string }> } };
              const v = dj?.content?.vessels?.[0];
              if (v?.endpoint) {
                repairUrl = `${v.endpoint.replace(/\/+$/, "")}${v.resolve_endpoint || "/resolve"}`;
                tap(`[goal-host-vessel] ${opts.surface}: ACTIVITY-REPAIR template_repair producer resolved via discovery → ${repairUrl}`);
              }
            } catch { /* discovery unreachable/empty → env fallback carries */ }
            const resp = await fetch(repairUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
              body: JSON.stringify({ impulse: { pointer: { type: "template_repair", activity_id: actId, failure_window: 5 } } }),
              signal: AbortSignal.timeout(120_000),
            });
            const j: any = await resp.json().catch(() => ({}));
            const body = (j?.body ?? j ?? {}) as Record<string, any>;
            const verdict = String(body.verdict ?? "");
            const errStr = typeof body.error === "string" ? body.error : "";
            if (verdict === "FAVORABLE") {
              const variantId = typeof body.variant_id === "string" && body.variant_id.trim() ? body.variant_id.trim() : null;
              const nFail = Array.isArray(body.based_on_failures) ? body.based_on_failures.length : 0;
              const summary = typeof body.summary === "string" && body.summary.trim() ? ` — ${body.summary.trim().slice(0, 160)}` : "";
              tap(`[goal-host-vessel] ${opts.surface}: ACTIVITY-REPAIR ROUTED to template_repair for "${actId}" → verdict=FAVORABLE${variantId ? ` variant=${variantId}` : ""} (grounded on ${nFail} failure trace(s))${summary}`);
              return {
                result: null,
                status: "completed",
                selectedTemplateId: "template_repair",
                completionShapes: ["activityVariant_write"],
                attempts: 1,
                goalReachReason: `routed activity-repair to template_repair; ${variantId ? `minted variant ${variantId}` : "grounded repair spec"} from ${nFail} failure trace(s)${summary}`,
                reached: true,
                executionId: variantId ? `template_repair:${variantId}` : undefined,
              };
            }
            // A non-template id (false-positive extraction) must not convert a goal
            // that today reaches recommend into a hard failure — fall through.
            if (/template not found/i.test(errStr)) {
              tap(`[goal-host-vessel] ${opts.surface}: ACTIVITY-REPAIR "${actId}" is not a fetchable template (${errStr.slice(0, 120)}) — falling through to authorFallback/recommend`);
            } else {
              const failWhy = (errStr || (typeof body.summary === "string" ? body.summary : "") || "no failure detail in repair report").slice(0, 200);
              tap(`[goal-host-vessel] ${opts.surface}: ACTIVITY-REPAIR ROUTED to template_repair for "${actId}" → verdict=${verdict || "(none)"} (${failWhy})`);
              return {
                result: null,
                status: "failed",
                selectedTemplateId: "template_repair",
                completionShapes: null,
                attempts: 1,
                goalReachReason: `routed activity-repair to template_repair; verdict=${verdict || "unknown"} (${failWhy})`,
                reached: false,
              };
            }
          } catch (e) {
            tap(`[goal-host-vessel] ${opts.surface}: ACTIVITY-REPAIR template_repair call failed (${(e as Error).message}) — falling through to authorFallback/recommend`);
            // fall through to the existing behaviour unchanged
          }
        }
      }
      console.log(`[goal-host-vessel] ${opts.surface}: pool-walk took 0 shape-feasible steps — falling back to single-template recovery loop`);
      // The walk (incl. the vessel-resolve satisfier) couldn't reach the goal via
      // existing/connected capability. NOW author a from-scratch template — only
      // here, not before the walk, so outward read-capability goals route to their
      // vessel first and a draft is the genuine last resort.
      if (opts.authorFallback) {
        try { authoredFallbackTarget = await opts.authorFallback(); } catch { /* author failed → recovery loop proceeds without a target */ }
      }
    } catch (e) {
      console.warn(`[goal-host-vessel] ${opts.surface}: pool-walk error (${(e as Error).message}) — falling back to single-template recovery loop`);
    }
  }
  const maxAttempts = opts.callerPinned || !goal ? 1 : opts.maxAttempts;
  const excluded: string[] = [];
  let nextTarget: string | undefined = opts.firstTarget ?? authoredFallbackTarget;
  if (!nextTarget && goal) {
    const reaching = await recommendReachingPath(goal);
    if (reaching) { nextTarget = reaching; console.log(`[goal-host-vessel] ${opts.surface}: reusing known-reaching path ${reaching}`); }
  }
  let result: Awaited<ReturnType<typeof host.runGoal>> | null = null;
  let status: "failed" | "completed" = "failed";
  let completionShapes: string[] | null = null;
  let goalReachReason: string | undefined;
  let reached = false;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    result = await host.runGoal(goal ?? `execute template ${nextTarget}`, {
      variables: opts.variables,
      targetTemplateId: nextTarget,
      tags: opts.tags,
      parentExecutionId: opts.parentExecutionId,
      compositionChain: opts.compositionChain,
      expectedOutputShapes: opts.expectedOutputShapes,
    });
    status = result.trace.status === "failed" ? "failed" : "completed";
    const selId = result.selectedTemplateId;
    reached = false;
    // Goal-reaching gate: a "completed" execution that didn't reach the goal is a
    // hollow completion — downgrade + β-penalise so Thompson stops reinforcing
    // goal-irrelevant gaming/wrapper templates. completion_shapes surface the
    // (emergent) goal-shaped direction, not a goal-declared target.
    if (goal && status === "completed" && selId) {
      try {
        const producedShapes = [...new Set(((result.trace as { tasks?: Array<{ outputShapes?: string[] }> }).tasks ?? []).flatMap((t) => t.outputShapes ?? []))];
        const taskSummary = (((result.trace as { tasks?: Array<{ taskId?: string; resolverId?: string; success?: boolean }> }).tasks) ?? []).map((t) => `${t.taskId}(${t.resolverId},${t.success ? "ok" : "fail"})`).join(", ");
        // Content digest: judge reach from ACTUAL produced content, not just shape
        // names. The trace's output impulses survive in the shared ImpulseStore
        // until the next top-level runGoal clears it, so a genuine content-bearing
        // single-template execution (e.g. analyze-source-to-concept, which really
        // writes a concept) is no longer indistinguishable from a hollow shape-
        // emitter. Mirrors the walk-path digest (2026-06-24). Degrades safely to
        // no digest when the store is unavailable.
        // Prefer the emit-time captured digest (real content, snapshotted before
        // eviction); fall back to a post-hoc store read (works for nested execs).
        const execId = (result.trace as { id?: string }).id;
        let contentDigest = (execId && reachContentDigests.get(execId)) || "";
        if (!contentDigest) {
          const store = (host as { runtime?: { store?: { get(id: string): { content?: unknown; metadata?: { shape?: string } } | undefined } } }).runtime?.store;
          const outImpulseIds = ((result.trace as { tasks?: Array<{ outputImpulseIds?: string[]; success?: boolean }> }).tasks ?? [])
            .filter((t) => t.success !== false)
            .flatMap((t) => t.outputImpulseIds ?? []);
          contentDigest = outImpulseIds
            .map((id) => store?.get(id))
            .filter((imp): imp is { content?: unknown; metadata?: { shape?: string } } => !!imp && imp.content !== undefined && imp.content !== null)
            .map((imp) => {
              const s = imp.metadata?.shape ?? "?";
              let c: string;
              try { c = typeof imp.content === "string" ? imp.content : JSON.stringify(imp.content); } catch { c = String(imp.content); }
              return `- ${s}: ${c.slice(0, 600)}`;
            })
            .join("\n")
            .slice(0, 4000);
        }
        const verdict = await verifyGoalReached(goal, producedShapes, taskSummary, contentDigest || undefined);
        completionShapes = verdict?.completion_shapes ?? null;
        reached = verdict?.reached !== false;
        if (verdict && verdict.reached === false) {
          status = "failed";
          goalReachReason = verdict.reason;
          await penaliseHollowTemplate(selId, verdict.reason ?? "goal not reached");
          console.log(`[goal-host-vessel] goal-reach(${opts.surface}) attempt ${attempt}/${maxAttempts}: HOLLOW via ${selId} — ${verdict.reason}; β-penalised. completion_shapes=${JSON.stringify(verdict.completion_shapes)}`);
        } else if (verdict && verdict.reached === true) {
          console.log(`[goal-host-vessel] goal-reach(${opts.surface}) attempt ${attempt}/${maxAttempts}: REACHED via ${selId}. completion_shapes=${JSON.stringify(verdict.completion_shapes)}`);
          void mintReachedTrace(result.trace as any);  // reach → mint the working trace into a new activity seed
        }
      } catch (e) { console.warn("[goal-host-vessel] goal-reach verify error (non-fatal):", (e as Error).message); }
    }
    // Per-goal learning: record this attempt's goal -> path -> reach outcome.
    const tr = result.trace as { durationMs?: number; costUsd?: number };
    if (goal && selId) void recordGoalPath(goal, [selId], reached, tr.durationMs ?? 0, tr.costUsd ?? 0);
    if (reached || !goal) break;  // reached (the trace is what the ribosome mints) — or no goal to recover toward
    if (selId) excluded.push(selId);
    // Alter the approach for the next attempt (engine-selected approaches only).
    if (attempt < maxAttempts) {
      const repairKey = repairSignatureOf(classifyFailure(goalReachReason), completionShapes ?? []);
        const alt = await recommendExcluding(goal, excluded, repairKey);
      if (!alt) { console.log(`[goal-host-vessel] ${opts.surface}: no fresh approach after ${attempt} attempts — honest failure`); break; }
      nextTarget = alt;
      console.log(`[goal-host-vessel] ${opts.surface}: altering approach → ${alt} (attempt ${attempt + 1}, excluded ${excluded.length})`);
    }
  }
  return { result, status, selectedTemplateId: result?.selectedTemplateId, completionShapes, attempts: attempt, goalReachReason, reached };
}
// Proxy resolver timeout (ms). Default 240s — must accommodate LLM-heavy
// dispatches (sonnet on ~45K-token inputs can take 90-180s) while staying
// under Bun's ~300s fetch cap. Override via GOAL_HOST_PROXY_TIMEOUT_MS.
const PROXY_TIMEOUT_MS = parseInt(process.env.GOAL_HOST_PROXY_TIMEOUT_MS ?? "240000", 10);

// ─────────────────────────────────────────────────────────────────────────────
// LLM port — HttpLLMPort when LLM_VESSEL_ENDPOINT is set, InProcessLLMPort
// otherwise. Vessel starts even without a key; errors surface at execute time.
// ─────────────────────────────────────────────────────────────────────────────

let anthropicClient: Anthropic | undefined;

if (!LLM_VESSEL_ENDPOINT) {
  if (!ANTHROPIC_API_KEY) {
    console.warn(
      "[goal-host-vessel] LLM_VESSEL_ENDPOINT and ANTHROPIC_API_KEY are both unset. " +
      "LLM-tier resolvers will fail until one is configured.",
    );
  } else {
    anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
}

const llm = createLLMPort(anthropicClient);

// ─────────────────────────────────────────────────────────────────────────────
// GoalHost
// ─────────────────────────────────────────────────────────────────────────────

// Inner event sink — default no-op (engine accepts undefined; default sink is
// the engine's internal noop). We wrap with BusForwardingEventSink so engine
// lifecycle events (lifecycle:task:preBinding, lifecycle:execution:succeeded,
// lifecycle:gap:classified, lifecycle:llm:dispatched) flow onto activity-api's
// WS bus via POST /v2/events/publish. Per openspec change
// 2026-05-27-neutral-emitter-lifecycle-bus, task 2.
//
// The forwarder is fire-and-forget: HTTP publish failures never block engine
// progression. Subscribers receive events with type mapped to the bus form
// (replace `:` with `.`, camelCase → snake_case).
const noopInnerSink = { emit: () => {} };
const busSink = new BusForwardingEventSink({
  inner: noopInnerSink,
  activityApiEndpoint: ACTIVITY_API_ENDPOINT,
  apiKey: API_KEY,
  sourceVesselId: "goal-host-vessel",
});

const boundedSink = new BoundedBusSink({ inner: busSink });

// ITER-4 DIAGNOSTIC: NoOp binary isolation. If GOAL_HOST_NOOP_SINK=1, bypass
// BusForwardingEventSink + BoundedBusSink entirely. Pure in-process noop. If
// cgroup stays bounded under boredom load, the leak source is the bus path
// (BusForwardingEventSink HTTP fetch / AbortSignal.timeout / response body).
// If cgroup still grows, the bus path is innocent and the leak is elsewhere
// (proxy resolver fetches, runtime internals, activity-api recommend).
const pureNoOpSink = { emit: () => {} };
const useNoOpSink = process.env.GOAL_HOST_NOOP_SINK === "1";
if (useNoOpSink) {
  console.log("[goal-host-vessel] ITER-4 DIAG: pure NoOp sink active (bus path disabled)");
}

// Iteration 10 — lifecycle subscriber ablation.
//
// Single-dispatch isolation test revealed: a single-task immunity-pattern
// template (detect-precondition-rejection) caused 37 MB → 2.7 GB in 30s
// (~90 MB/sec growth). Iter-8 fixed the idle-WS leak; iter-10 addresses
// the dispatch-path leak which is distinct.
//
// Hypothesis: every task.completed event fires the validator-dispatch
// subscriber template (a 5-task LLM-using activity). Iter-3
// (concept_KAQEz-Xq5FwT) made dispatchSubscribers use void-async so they
// don't block the parent, BUT it didn't bound concurrency. With each
// validator-dispatch execution emitting 5 more task.completed events,
// the recursive cascade is unbounded.
//
// Gated on GOAL_HOST_DISABLE_SUBSCRIBERS env. Default OFF (subscribers
// enabled — preserve original behavior). Set =1 to pass empty
// subscriberTemplates to GoalHost, disabling lifecycle dispatch entirely.
//
// When disabled, we lose:
//   - validator-dispatch (per-task validation against rules + LLM judge)
//   - slot-binding (impulse-pool pre-binding by shape)
//   - audit-test-report and other registered subscribers
// But we gain stability. Until a durable bounded-subscriber-dispatch is
// shipped in ias-executor-ts, this ablation is the operational workaround.
const DISABLE_SUBSCRIBERS = process.env.GOAL_HOST_DISABLE_SUBSCRIBERS === "1";
if (DISABLE_SUBSCRIBERS) {
  console.log("[startup] Lifecycle subscribers DISABLED via GOAL_HOST_DISABLE_SUBSCRIBERS=1 (iter-10 ablation)");
}

// Reach-gate content capture (2026-06-24). The engine evicts a top-level
// execution's output impulses from the shared ImpulseStore *before*
// runGoal/runTemplate returns (evictExecutionScope, isTopLevel), so the
// reach-gate can't read produced content post-hoc — it would false-HOLLOW a
// genuinely content-bearing single-template execution (e.g. analyze-source-to-
// concept, which really writes a concept). But `lifecycle:execution:succeeded`
// is emitted WHILE the store is still live (emit precedes eviction), carrying
// executionId + outputImpulseIds. Snapshot the real content here, keyed by
// executionId, so verifyGoalReached judges genuine artifacts. Best-effort and
// bounded; degrades to the store/pool digest when absent.
const reachContentDigests = new Map<string, string>();
const REACH_DIGEST_CAP = 100;
function captureReachDigest(event: unknown): void {
  try {
    const e = event as { type?: string; data?: Record<string, unknown> };
    if (e?.type !== "lifecycle:execution:succeeded") return;
    const data = e.data ?? {};
    const execId = typeof data.executionId === "string" ? data.executionId : undefined;
    const outIds = Array.isArray(data.outputImpulseIds) ? (data.outputImpulseIds as string[]) : [];
    if (!execId || outIds.length === 0) return;
    const store = (host as { runtime?: { store?: { get(id: string): { content?: unknown; metadata?: { shape?: string } } | undefined } } })?.runtime?.store;
    if (!store) return;
    const digest = outIds
      .map((id) => store.get(id))
      .filter((imp): imp is { content?: unknown; metadata?: { shape?: string } } => !!imp && imp.content !== undefined && imp.content !== null)
      .map((imp) => {
        const s = imp.metadata?.shape ?? "?";
        let c: string;
        try { c = typeof imp.content === "string" ? imp.content : JSON.stringify(imp.content); } catch { c = String(imp.content); }
        return `- ${s}: ${c.slice(0, 600)}`;
      })
      .join("\n")
      .slice(0, 4000);
    if (!digest) return;
    if (reachContentDigests.size >= REACH_DIGEST_CAP) {
      const first = reachContentDigests.keys().next().value;
      if (first !== undefined) reachContentDigests.delete(first);
    }
    reachContentDigests.set(execId, digest);
  } catch { /* capture is best-effort; never break the emit path */ }
}
class CapturingEventSink implements EventSink {
  constructor(private readonly inner: EventSink) {}
  emit(event: Parameters<EventSink["emit"]>[0]): void | Promise<void> {
    captureReachDigest(event);
    return this.inner.emit(event);
  }
}

const host = new GoalHost({
  llm,
  activityApiEndpoint: ACTIVITY_API_ENDPOINT,
  apiKey: API_KEY,
  discoveryEndpoint: DISCOVERY_ENDPOINT,
  enableAgentFill: true,
  eventSink: (useNoOpSink ? pureNoOpSink : new CapturingEventSink(boundedSink)) as unknown as typeof busSink,
  ...(DISABLE_SUBSCRIBERS ? { subscriberTemplates: [] } : {}),
});

// ─────────────────────────────────────────────────────────────────────────────
// getTemplate: LOCAL-first, HUB-fallback (2026-07-01 template-fetch split)
//
// host.activityApi is bound to ACTIVITY_API_ENDPOINT (the federation hub) for
// trace/feedback/recommend. But the shape-walk SELECTS genuine producers found
// via PRODUCER_DISCOVERY_ENDPOINT (the LOCAL activity-api) — templates like
// `understand-source-file-demo` / `auto-bridge-*` that live ONLY locally and
// 404 on the hub. Fetching them by id through host.activityApi (hub) returns
// null → "template unfetchable" → the correctly-selected genuine producer can't
// run → the goal hollow-completes.
//
// Fix: template-fetch-by-id resolves the template from WHERE IT LIVES — try the
// local activity-api first, fall back to the hub. This keeps hub-only templates
// (SHARED_TEMPLATES the autonomous loop relies on, e.g. ribosome-extract)
// fetchable, and makes local genuine producers runnable.
//
// getTemplate is fetched from TWO paths, both of which must become local-first:
//   1. the vessel's shape-walk (host.activityApi.getTemplate at the two sites
//      below); and
//   2. the LIBRARY's host.runGoal(targetTemplateId) recovery/target path, which
//      internally does runtime.templateProvider.getTemplate → CatalogueWithFallback
//      whose REMOTE fallback IS host.activityApi. A local-only targetTemplateId
//      (e.g. development-vessel:scaffold-and-publish-vessel) 404s on the hub and
//      the library HARD-THROWS "template not found".
// Both share host.activityApi as the fetch surface, so we wrap that single
// method local-first. recommend / recordTrace / asTraceSink are untouched — they
// stay on ACTIVITY_API_ENDPOINT (federation-wide credit / learning), so no
// write/trace/recommend path changes.
const localTemplateApi =
  PRODUCER_DISCOVERY_ENDPOINT === ACTIVITY_API_ENDPOINT
    ? null
    : new ActivityApiAdapter(PRODUCER_DISCOVERY_ENDPOINT, API_KEY ?? "");

// Capture the hub-bound getTemplate BEFORE wrapping, to avoid recursion.
const hubGetTemplate = host.activityApi.getTemplate.bind(host.activityApi);

async function getTemplateLocalFirst(id: string): Promise<ActivityTemplate | null> {
  if (localTemplateApi) {
    try {
      const local = await localTemplateApi.getTemplate(id);
      if (local) return local;
    } catch (e) {
      console.warn(`[goal-host-vessel] getTemplateLocalFirst(${id}): local fetch threw, falling back to hub: ${(e as Error).message}`);
    }
  }
  // Fall back to the hub (original host.activityApi.getTemplate).
  return hubGetTemplate(id);
}

// Wrap host.activityApi.getTemplate in place so the library's CatalogueWithFallback
// (host.runGoal target/recovery path) also resolves local-first. Only when a
// distinct local endpoint exists — otherwise it's a no-op passthrough.
if (localTemplateApi) {
  (host.activityApi as { getTemplate: (id: string) => Promise<ActivityTemplate | null> }).getTemplate =
    (id: string) => getTemplateLocalFirst(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in resolvers referenced by SHARED_TEMPLATES but not in GoalHost core
//
// SHARED_TEMPLATES (ias-executor-ts) ship escalation templates (e.g.
// create-shape-provider-goal) whose tasks reference resolvers that GoalHost
// doesn't register by default.  We register them here so those templates can
// execute inside the substrate.
// ─────────────────────────────────────────────────────────────────────────────

function registerBuiltinResolvers(): void {
  // activity_recommendation — wraps POST /v2/activities/recommend.
  // Used by create-shape-provider-goal:forward_chain_producers to find activity
  // templates that produce a required output shape.
  host.runtime.resolvers.register({
    id: "activity_recommendation",
    tier: "pattern" as const,
    async resolve(context: any): Promise<any> {
      const task = context.task as Record<string, unknown> | undefined;
      const config = (task?.config ?? {}) as Record<string, unknown>;
      const variables = (context.variables ?? {}) as Record<string, unknown>;
      const random = context.random as { id: (prefix: string) => string };

      const limit = typeof config.limit === "number" ? config.limit : 5;
      const minSuccessRate = typeof config.minSuccessRate === "number" ? config.minSuccessRate : 0.0;

      // Collect goal text and shape hints from variables injected by GoalHost
      const goal = typeof variables.goal === "string" ? variables.goal
        : typeof variables.goalDescription === "string" ? variables.goalDescription
        : undefined;
      const requiredShape = typeof variables.requiredShape === "string" ? variables.requiredShape
        : typeof variables.targetShape === "string" ? variables.targetShape
        : undefined;

      const body: Record<string, unknown> = {
        limit,
        min_success_rate: minSuccessRate,
      };
      if (goal) body.goal = goal;
      if (requiredShape) body.expected_output_shapes = [requiredShape];

      // ITER-4 fix: manual timer cleanup + body drain.
      const recCtrl = new AbortController();
      const recTimer = setTimeout(() => recCtrl.abort(), 15_000);
      try {
        const resp = await fetch(`${ACTIVITY_API_ENDPOINT}/v2/activities/recommend`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}),
          },
          body: JSON.stringify(body),
          signal: recCtrl.signal,
        });
        clearTimeout(recTimer);
        const result = await resp.json();
        return [{
          id: random.id("activity_rec"),
          pointer: { type: "memo" },
          metadata: { shape: "activityTemplateRecommendation", source: "activity-api", ok: resp.ok },
          loaded: true,
          content: result,
        }];
      } catch (err) {
        clearTimeout(recTimer);
        return [{
          id: random.id("activity_rec:err"),
          pointer: { type: "memo" },
          metadata: { shape: "activityTemplateRecommendation", source: "activity-api", degraded: true },
          loaded: true,
          content: { error: (err as Error).message, recommendations: [] },
        }];
      }
    },
  });

  console.log("[goal-host-vessel] registered built-in resolver: activity_recommendation");

  // impulse_cooccurrence — stateless co-occurrence pair-counter used by
  // create-shape-provider-goal:cooccurrence_signal. The template always passes
  // config.traces:[] (no upstream trace fetch exists), so this resolver always
  // runs over an empty trace set and emits an empty matrix. compose_goal handles
  // empty signal 4 defensively.
  host.runtime.resolvers.register({
    id: "impulse_cooccurrence",
    tier: "pattern" as const,
    async resolve(context: any): Promise<any> {
      const random = context.random as { id: (prefix: string) => string };
      const id = random.id("cooccurrence");
      return [{
        id,
        pointer: { type: "memo" },
        metadata: {
          shape: "cooccurrenceRanking",
          source: "impulse_cooccurrence",
          summary: "0 pairs across 0 traces",
        },
        loaded: true,
        content: { pairs: [], trace_count: 0 },
      }];
    },
  });

  console.log("[goal-host-vessel] registered built-in resolver: impulse_cooccurrence");

  // noop — trivial pass-through. Several SHARED_TEMPLATES (ribosome-extract's
  // dispatch_write_succeeded sentinel, etc.) declare resolver:"noop" expecting a
  // no-op success, but goal-host only registered "lift_demo_noop" — so those tasks
  // hit activities-as-resolvers (getTemplate("noop") → not found) and FAILED,
  // failing the whole template (e.g. ribosome-extract minted nothing because its
  // final sentinel task errored). Register a real noop.
  host.runtime.resolvers.register({
    id: "noop",
    tier: "deterministic" as const,
    async resolve(context: any) {
      const random = context.random as { id: (p: string) => string };
      return [{
        id: random.id("noop"),
        pointer: { type: "memo" },
        metadata: { shape: "noop" },
        loaded: true,
        content: { ok: true },
      }];
    },
  });
  console.log("[goal-host-vessel] registered built-in resolver: noop");

  // llm (OVERRIDE) — richer prompt interpolation than the GoalHost built-in.
  //
  // The GoalHost core `llm` resolver (ias-executor-ts hosts/goal-host.ts) only
  // interpolates `{{word}}` from context.variables. But config.prompt templates
  // routinely use the proxy-slot syntax `{{impulse:<slot>}}` (a producing task's
  // output, referenced by that task's id) and dotted paths `{{a.b.c}}` — neither
  // of which the built-in binds, so the prompt reaches the LLM with a LITERAL
  // `{{impulse:read_source}}` / `{{goal.id}}` and no upstream content. The
  // reach-gate then correctly judges the output HOLLOW ("the template variable
  // was not filled in and no actual source code was provided"). This is the last
  // binding layer: discover→select→fetch→run all work, but a chained producer's
  // prompt placeholders don't get substituted.
  //
  // This override is a STRICT SUPERSET of the built-in:
  //   • `{{word}}`        → variables[word]              (built-in behaviour, preserved)
  //   • `{{a.b.c}}`       → variables.a.b.c              (dotted-path, via interpolateProxyValue)
  //   • `{{impulse:S}}`   → the slot S, resolved from (a) input impulses stamped
  //                         with outputImpulseKey=S, then (b) variables[S] — which
  //                         the engine populates as `{{<taskId>}}` = that task's
  //                         first output content (engine.ts accumulatedVariables).
  //   • `{{shapeName}}`   → an input impulse whose metadata.shape === shapeName.
  // Unresolved placeholders remain LITERAL (matches interpolateProxyValue and the
  // built-in). No engine/dist edit; last-registration-wins overrides the built-in.
  host.runtime.resolvers.register({
    id: "llm",
    tier: "llm" as const,
    async resolve(context: any): Promise<any> {
      const task = context.task as { config?: Record<string, unknown> };
      const config = (task.config ?? {}) as Record<string, unknown>;
      const rawPrompt = config.prompt;
      if (typeof rawPrompt !== "string") {
        throw new Error(`llm resolver requires task.config.prompt (got ${JSON.stringify(rawPrompt)})`);
      }
      const systemPrompt = typeof config.systemPrompt === "string" ? config.systemPrompt : undefined;
      const variables = (context.variables ?? {}) as Record<string, unknown>;
      const inputImpulses = context.inputImpulses;

      // Slot map: outputImpulseKey-stamped inputs first (Idiom-6 named slots),
      // then a fallback so `{{impulse:<taskId>}}` binds from the engine's
      // task-id-keyed accumulatedVariables when no named slot was declared.
      const impulseSlots = buildImpulseSlots(inputImpulses);
      if (Array.isArray(inputImpulses)) {
        for (const imp of inputImpulses) {
          const shape = (imp as { metadata?: Record<string, unknown> })?.metadata?.["shape"];
          const content = (imp as { content?: unknown }).content;
          if (typeof shape === "string" && shape && content != null && !impulseSlots.has(shape)) {
            impulseSlots.set(shape, content);
          }
        }
      }
      // Fill any `{{impulse:<slot>}}` slot the prompt references but the input
      // impulses didn't provide, from a matching variable (engine sets
      // variables[<taskId>] = that task's first output content).
      for (const m of rawPrompt.matchAll(/\{\{\s*impulse:([\w.-]+)\s*\}\}/g)) {
        const slot = m[1];
        if (slot && !impulseSlots.has(slot) && variables[slot] != null) {
          impulseSlots.set(slot, variables[slot]);
        }
      }
      // Expose input impulses by shape as plain `{{shapeName}}` variables too,
      // without shadowing an explicit variable of the same name.
      const varsWithShapes: Record<string, unknown> = { ...variables };
      for (const [k, v] of impulseSlots) if (!(k in varsWithShapes)) varsWithShapes[k] = v;

      const prompt = interpolateProxyValue(rawPrompt, varsWithShapes, impulseSlots) as string;
      const text = await llm.generate({ prompt, systemPrompt });
      const random = context.random as { id: (p: string) => string };
      return [{
        id: random.id("llm"),
        pointer: { type: "memo" },
        metadata: { shape: "llmText", summary: String(text).slice(0, 120) },
        loaded: true,
        content: text,
      }];
    },
  });
  console.log("[goal-host-vessel] registered built-in resolver: llm (override — impulse:/dotted/shape interpolation)");
}

// ─────────────────────────────────────────────────────────────────────────────
// Development-vessel proxy resolvers
//
// GoalHost only knows its own built-in resolvers (fs, bash, llm, slot-binding,
// etc.). Templates seeded by development-vessel use resolver IDs like
// "fs_read", "coverage_tick", or "development-vessel:coverage_tick" — names
// that live in development-vessel, not in GoalHost's registry.
//
// Fix: at startup, fetch /shapes from development-vessel and register a proxy
// resolver for each shape. Each proxy POSTs to development-vessel's
// /v2/impulses/resolve endpoint with a pointer built from task.config.
// Registered under both the bare name ("coverage_tick") and the
// qualified name ("development-vessel:coverage_tick") so both conventions work.
// ─────────────────────────────────────────────────────────────────────────────

// Currently-registered proxy shape ids, tracked so re-registration can be idempotent
// and produce useful diff logs. Keyed on the bare shape name (we register both bare
// and qualified forms but the bare name is the canonical identity).
const registeredProxyShapes = new Set<string>();

// shape -> {endpoint, resolvePath} captured at registration time from the vessel
// registry (which carries endpoints), because the per-resolve vesselCapability
// lookup returns a null endpoint. The discovery-proxy uses this map first.
const shapeEndpointMap = new Map<string, { endpoint: string; resolvePath: string }>();

/**
 * Interpolate {{var}} and {{a.b}} placeholders in a value. Mirrors the
 * semantics in resolvers/llm-prompt.ts (the engine's llm path interpolates,
 * but proxy resolvers in this file bypass that — so register_variant tasks
 * with config like `{template: "{{draft_via_llm_text}}"}` were forwarding
 * the literal placeholder to dev-vessel, which then rejected on parse, which
 * proxy treated as success because activity_create_variant returns a
 * structuredError without `failure_mode` field. Triple silent failure.
 *
 * Handles strings, arrays, and plain objects recursively. Unresolved
 * placeholders remain literal (matches llm-prompt behavior).
 */
// Build a named-slot map { <slot> -> impulse.content } from a task's resolved
// input impulses. The engine pulls impulses stamped with metadata.outputImpulseKey
// into context.inputImpulses (Idiom-6 named-input slots); this exposes them for
// `{{impulse:<slot>}}` interpolation in proxy configs (e.g. ribosome-extract's
// dispatch_write_attempt body `"templateData": {{impulse:extracted_template}}`).
function buildImpulseSlots(impulses: unknown): Map<string, unknown> {
  const slots = new Map<string, unknown>();
  if (!Array.isArray(impulses)) return slots;
  for (const imp of impulses) {
    const meta = (imp as { metadata?: Record<string, unknown> })?.metadata;
    const key = meta && typeof meta["outputImpulseKey"] === "string" ? (meta["outputImpulseKey"] as string) : undefined;
    if (key) slots.set(key, (imp as { content?: unknown }).content);
  }
  return slots;
}

function interpolateProxyValue(value: unknown, variables: Record<string, unknown>, impulseSlots?: Map<string, unknown>): unknown {
  if (typeof value === "string") {
    // Token grammar now allows a single `impulse:<slot>` prefix (the colon) in
    // addition to dotted variable paths. Without the colon the old regex left
    // `{{impulse:extracted_template}}` LITERAL, so the ribosome's write body was
    // malformed and never persisted a template.
    return value.replace(/\{\{\s*(impulse:[\w.-]+|[\w]+(?:\.[\w]+)*)\s*\}\}/g, (match, path: string) => {
      if (path.startsWith("impulse:")) {
        const slot = path.slice("impulse:".length);
        const content = impulseSlots?.get(slot);
        if (content === undefined || content === null) return match; // unresolved → literal
        if (typeof content === "string") return content;
        try { return JSON.stringify(content); } catch { return match; }
      }
      const segs = path.split(".");
      let cur: unknown = variables;
      for (const seg of segs) {
        if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[seg];
        } else {
          return match; // unresolved → leave literal
        }
      }
      if (cur === undefined || cur === null) return match;
      if (typeof cur === "string") return cur;
      if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
      try { return JSON.stringify(cur); } catch { return match; }
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolateProxyValue(v, variables, impulseSlots));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateProxyValue(v, variables, impulseSlots);
    }
    return out;
  }
  return value;
}

function buildProxyResolver(shape: string) {
  return {
    id: shape,
    tier: "pattern" as const,
    async resolve(context: Record<string, unknown>) {
      const task = context.task as Record<string, unknown>;
      const configRaw = (task.config ?? {}) as Record<string, unknown>;
      const variables = (context.variables ?? {}) as Record<string, unknown>;
      const random = context.random as { id: (prefix: string) => string };
      // Interpolate {{var}} placeholders in task.config BEFORE building the pointer
      // so dev-vessel resolvers receive substituted values rather than literal
      // placeholder strings (which were causing silent failures in
      // register_variant — see comment on interpolateProxyValue).
      const impulseSlots = buildImpulseSlots(context.inputImpulses);
      const config = interpolateProxyValue(configRaw, variables, impulseSlots) as Record<string, unknown>;
      // Spread variables BEFORE config so the interpolated config wins on key
      // conflicts. Templates intentionally use variable names that match
      // config-key meanings inside the activity layer (e.g. target_branch
      // means "feature branch" to the activity but "PR base" to gh_pr_create's
      // config). If variables spread last, they shadow the config's
      // interpolated value, and the resolver sees the wrong field. Variables
      // remain available for resolvers whose pointer fields aren't explicit
      // in the task config — they just don't override an interpolated config.
      const pointer: Record<string, unknown> = { type: shape, ...variables, ...config };
      // ITER-4 fix: manual AbortController + clearTimeout instead of
      // AbortSignal.timeout — the implicit timer leaks native buffers. Also
      // drain response body explicitly via .cancel() since Bun retains the
      // readable stream mmap pages even after .text() consumes them.
      const proxyCtrl = new AbortController();
      const proxyTimer = setTimeout(() => proxyCtrl.abort(), PROXY_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}),
          },
          body: JSON.stringify({ impulse: { pointer } }),
          signal: proxyCtrl.signal,
        });
      } finally {
        clearTimeout(proxyTimer);
      }
      try {
        const bodyText = await resp.text();
        let parsed: unknown;
        try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }

        // Detect resolver-level failure even when HTTP returns 200. Dev-vessel's
        // /v2/impulses/resolve route wraps the resolver's ResolverResult as
        // { success: true, shape, body }. When the resolver itself produced a
        // failure-mode-tagged structuredError (e.g. URL invalid, downstream
        // 4xx, validation rejection), the body carries the signal but the HTTP
        // status is still 200. Without propagating this, every chained activity
        // (draft-gap-closing-activity, etc.) reports task=success on a silent
        // failure — the substrate has been swallowing real errors. Throw so
        // the engine records task.failure with the resolver's reason.
        if (!resp.ok) {
          throw new Error(`dev-vessel ${shape} HTTP ${resp.status}: ${bodyText.slice(0, 200)}`);
        }
        const parsedObj = (typeof parsed === "object" && parsed !== null) ? (parsed as Record<string, unknown>) : null;
        if (parsedObj) {
          const innerShape = parsedObj["shape"];
          const innerBody = parsedObj["body"] as Record<string, unknown> | undefined;
          // Any structuredError shape signals resolver-level failure — the
          // resolver explicitly chose this shape to indicate an error. The
          // earlier narrower guard (require failure_mode set) missed cases
          // like activity_create_variant 4xx responses which return
          // structuredError WITHOUT failure_mode. Treat all of them as task
          // failure so the substrate sees real signal instead of silent
          // swallowing.
          if (innerShape === "structuredError") {
            const reason = innerBody?.["failure_mode"]
              ? `failure_mode=${innerBody["failure_mode"]}`
              : `status=${innerBody?.["status"] ?? "n/a"}`;
            const detail = String(innerBody?.["detail"] ?? innerBody?.["error"] ?? "no detail");
            throw new Error(`dev-vessel ${shape} resolver returned structuredError (${reason}): ${detail.slice(0, 200)}`);
          }
        }

        // Unwrap the dev-vessel response envelope. Dev-vessel's /v2/impulses/resolve
        // wraps every resolver's ResolverResult as { success, shape, body }. The
        // outer wrapper is plumbing, not content — when subsequent tasks reference
        // {{<taskId>_text}}, they want body's content (e.g. body.text for llm,
        // body.variantId for activity_create_variant), not the wrapper object.
        // Without this unwrap, register_variant gets fed the entire envelope and
        // activity-api rejects on schema validation. Set impulse.content = body
        // when the wrapper shape is detected; else pass parsed through.
        let impulseContent: unknown = parsed;
        if (parsedObj && parsedObj["success"] === true && "body" in parsedObj) {
          const innerBody = parsedObj["body"];
          const innerShapeName = parsedObj["shape"];
          // For llm-completion-style results, the text is the canonical content
          // of the response. For other shapes, return the body object.
          if (innerBody && typeof innerBody === "object" && !Array.isArray(innerBody)) {
            const body = innerBody as Record<string, unknown>;
            if (innerShapeName === "llm_completion_result" && typeof body["text"] === "string") {
              // Strip markdown code fences that LLMs commonly wrap JSON in.
              let text = body["text"] as string;
              text = text.replace(/^```(?:json|JSON)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
              impulseContent = text;
            } else if (innerShapeName === "fileContent" && typeof body["content"] === "string") {
              // fs_read returns {shape:"fileContent", body:{content:"..."}}. Unwrap so
              // {{taskId_content}} gives the raw file string rather than the envelope object.
              impulseContent = body["content"];
            } else if (innerShapeName === "json_extracted_value") {
              // json_path_extract returns {valueJson, value, path}. Expose value directly.
              impulseContent = body["value"] ?? body["valueJson"] ?? innerBody;
            } else {
              impulseContent = innerBody;
            }
          } else {
            impulseContent = innerBody;
          }
        }

        return [{
          id: random.id(`dev:${shape}`),
          pointer: { type: "memo" },
          metadata: { shape, source: "development-vessel", ok: resp.ok },
          loaded: true,
          content: impulseContent,
        }];
      } catch (err) {
        // F13 fix (inv-084): re-throw so engine records success=false + β+=1.
        // Previously: returning a degraded impulse caused engine to record
        // success=true → Thompson α+=1 for every failed dev-vessel call.
        // This corrupted posteriors — drain cycles accumulated false-positive α
        // even when fs_write/llm_completion tasks consistently failed.
        // Re-throwing lets the engine task-catch handle it correctly.
        throw err;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery-routed proxy resolvers (cross-vessel dispatch).
//
// goal-host natively dispatches local resolvers + dev-vessel proxies. Shapes
// advertised by OTHER vessels (e.g. obsidian-vessel's obsidian:workspace_state /
// obsidian:write_note) had NO resolver, so an authored activity composing them
// failed "Resolver not registered" before task 1 — the runtime-dispatch blocker
// that stopped authored obsidian activities from executing. This proxy looks the
// shape's producer up in discovery AT RESOLVE TIME (so vessel restarts are picked
// up) and POSTs to its resolve_endpoint. Generalises the dev-vessel proxy to the
// "resolvers live where data lives + discovery enables dynamic routing" principle.
// Fallback list if the vessel registry is unreachable at startup. The LIVE list
// is discovered from the registry (see registerDiscoveryProxies) so the substrate
// composes from obsidian's FULL advertised capability surface — "understand how to
// use obsidian" (incl. execute_command, command_catalog, graph_query, canvas) —
// rather than a hardcoded subset that left the author blind to real capabilities.
const DISCOVERY_PROXY_SHAPE_FALLBACK: string[] = [
  "obsidian:workspace_state", "obsidian:note", "obsidian:write_note",
  "obsidian:search", "obsidian:backlinks", "obsidian:frontmatter",
  "obsidian:daily_note", "obsidian:command_catalog", "obsidian:open_note",
];
let discoveredProxyShapes: string[] = [...DISCOVERY_PROXY_SHAPE_FALLBACK];

function buildDiscoveryProxyResolver(shape: string) {
  return {
    id: shape,
    tier: "pattern" as const,
    async resolve(context: Record<string, unknown>) {
      const task = context.task as Record<string, unknown>;
      const configRaw = (task.config ?? {}) as Record<string, unknown>;
      const variables = (context.variables ?? {}) as Record<string, unknown>;
      const random = context.random as { id: (prefix: string) => string };
      const impulseSlots = buildImpulseSlots(context.inputImpulses);
      const config = interpolateProxyValue(configRaw, variables, impulseSlots) as Record<string, unknown>;
      const pointer: Record<string, unknown> = { type: shape, ...variables, ...config };

      // 1. Resolve the producer endpoint via discovery (lazy → survives restarts).
      const discCtrl = new AbortController();
      const discTimer = setTimeout(() => discCtrl.abort(), 5_000);
      let endpoint = "";
      let resolvePath = "/resolve";
      const mapped = shapeEndpointMap.get(shape);
      if (mapped?.endpoint) {
        endpoint = mapped.endpoint;
        resolvePath = mapped.resolvePath;
        clearTimeout(discTimer);
      } else {
        try {
          const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
            body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
            signal: discCtrl.signal,
          });
          const dj = await dr.json() as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string; discoveredVia?: string; peerEndpoint?: string; protocol?: string; libp2p_multiaddr?: string[] }> } };
          const v = dj?.content?.vessels?.[0];
          if (!v?.endpoint) throw new Error(`discovery: no vessel advertises ${shape}`);
          if (v.discoveredVia === "peer" && v.protocol === "libp2p" && Array.isArray(v.libp2p_multiaddr) && v.libp2p_multiaddr[0]) {
            // libp2p-reachable peer (e.g. the operator-host obsidian sidecar): its
            // advertised endpoint is a NATed loopback, so route the resolve through the
            // local federation-transport egress (goal-host carries no libp2p deps),
            // passing the peer multiaddr as ?target=. Mirrors endpointForShape so a
            // remote-vessel shape used as a TASK RESOLVER routes the same way the walk
            // satisfier already does — fixes resolver_not_registered for obsidian:* etc.
            endpoint = FED_TRANSPORT_EGRESS.replace(/\/+$/, "");
            resolvePath = `/egress/resolve?target=${encodeURIComponent(v.libp2p_multiaddr[0])}`;
          } else if (v.discoveredVia === "peer" && v.peerEndpoint) {
            endpoint = v.peerEndpoint.replace(/\/+$/, "");
            resolvePath = v.resolve_endpoint || "/resolve";
          } else {
            endpoint = v.endpoint.replace(/\/+$/, "");
            resolvePath = v.resolve_endpoint || "/resolve";
          }
        } finally {
          clearTimeout(discTimer);
        }
      }

      // 2. POST to the producer vessel (wrapped impulse-contract form; obsidian
      //    accepts both flat and {impulse:{pointer}}).
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(`${endpoint}${resolvePath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
          body: JSON.stringify({ impulse: { pointer } }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const bodyText = await resp.text();
      if (!resp.ok) throw new Error(`${shape} via ${endpoint} HTTP ${resp.status}: ${bodyText.slice(0, 200)}`);
      let parsed: unknown;
      try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }

      // 3. Unwrap: obsidian → {success, content, metadata}; dev-vessel-style → {success, shape, body}.
      let impulseContent: unknown = parsed;
      const pObj = (typeof parsed === "object" && parsed !== null) ? parsed as Record<string, unknown> : null;
      if (pObj) {
        if (pObj["success"] === false) {
          throw new Error(`${shape} resolver returned error: ${String(pObj["error"] ?? "no detail").slice(0, 200)}`);
        }
        if ("content" in pObj) impulseContent = pObj["content"];
        else if ("body" in pObj) impulseContent = pObj["body"];
      }

      return [{
        id: random.id(`disc:${shape}`),
        pointer: { type: "memo" },
        metadata: { shape, source: "discovery", endpoint, ok: resp.ok },
        loaded: true,
        content: impulseContent,
      }];
    },
  };
}

/**
 * Build-lint for auto-drafted templates. Verifies STRUCTURAL validity (every
 * task.resolver is dispatchable through goal-host's proxy, and every
 * {{impulse:<slot>}} consumer slot is backed by a producing task that declares it
 * in outputImpulses) and auto-repairs the one mechanical defect the auto-draft
 * path keeps making: raw `llm_completion` / `llmCompletion` (advertised but
 * non-dispatchable — goal-host sends pointer.prompt, llm-resolver-vessel reads a
 * body-level prompt) → the dispatch wrapper `llm_completion_dispatch`. Repair is
 * persisted via activityTemplate_update (bare id + auditable evidence). This is
 * validity only — it does NOT assert the template reaches the operator's goal.
 */
async function lintAndRepairAuthoredTemplate(
  templateId: string,
  dispatchId: string,
  goalText: string,
): Promise<{ repaired: string[]; invalidResolvers: string[]; unboundSlots: string[] }> {
  const out = { repaired: [] as string[], invalidResolvers: [] as string[], unboundSlots: [] as string[] };
  const RAW_LLM_ALIAS: Record<string, string> = { llm_completion: "llm_completion_dispatch", llmCompletion: "llm_completion_dispatch" };
  // activityTemplate_update resolves the record by BARE id (no `activity:` / ⟨⟩ wrap).
  const bareId = templateId.replace(/^activity:/, "").replace(/[⟨⟩]/g, "");
  const apiKey = process.env.METABOB_API_KEY ?? "";
  try {
    const getRes = await fetch(
      `${ACTIVITY_API_ENDPOINT}/v2/activities/select-activity-for-goal`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `ApiKey ${apiKey}`,
        },
        body: JSON.stringify({ goal: bareId, apiKey }),
      },
    );
    if (!getRes.ok) return out;
    const lj = await getRes.json() as { templates?: Array<Record<string, unknown>> };
    const tmpl = (lj.templates ?? []).find((t) => typeof t.id === "string" && (t.id as string).includes(bareId));
    const tasks = Array.isArray(tmpl?.tasks) ? (tmpl!.tasks as Array<Record<string, unknown>>) : [];
    if (tasks.length === 0) return out;

    // Producer slots declared anywhere in the chain (task.outputImpulses).
    const producerSlots = new Set<string>();
    for (const t of tasks) {
      const outs = Array.isArray(t.outputImpulses) ? t.outputImpulses : [];
      for (const s of outs) if (typeof s === "string") producerSlots.add(s);
    }
    const isDispatchable = (id: string): boolean => {
      if (id in RAW_LLM_ALIAS) return false;       // raw llm shapes: registered but envelope-incompatible
      try { return !!host.runtime.resolvers.get(id); } catch { return false; }
    };

    let changed = false;
    for (const t of tasks) {
      const rid = typeof t.resolver === "string" ? t.resolver : "";
      if (rid in RAW_LLM_ALIAS) {
        t.resolver = RAW_LLM_ALIAS[rid];
        out.repaired.push(`${String(t.id)}: ${rid}→${t.resolver}`);
        changed = true;
      } else if (rid && !isDispatchable(rid)) {
        out.invalidResolvers.push(`${String(t.id)}:${rid}`);
      }
      const ins = Array.isArray(t.inputImpulses) ? t.inputImpulses : [];
      for (const slot of ins) {
        if (typeof slot === "string" && !producerSlots.has(slot)) out.unboundSlots.push(`${String(t.id)}:{{impulse:${slot}}}`);
      }
    }

    if (changed) {
      const body = JSON.stringify({ impulse: { type: "activityTemplate_update", pointer: {
        type: "activityTemplate_update",
        templateId: bareId,
        updates: { tasks },
        evidence: {
          reason: `auto-draft build-lint repaired non-dispatchable resolver ids for goal "${goalText.slice(0, 80)}"`,
          lint: "resolver_id_nondispatchable",
          dispatchId,
          repaired: out.repaired,
        },
      } } });
      try {
        const up = await fetch(`${ACTIVITY_API_ENDPOINT}/v2/impulses/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
          body,
        });
        const ut = await up.text();
        if (!up.ok || ut.includes('"success":false')) {
          console.warn(`[goal-host-vessel] lint repair update did not persist: ${ut.slice(0, 160)}`);
        }
      } catch (e) {
        console.warn(`[goal-host-vessel] lint repair update error:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.warn(`[goal-host-vessel] lintAndRepairAuthoredTemplate error:`, e instanceof Error ? e.message : e);
  }
  return out;
}

async function registerDiscoveryProxies(): Promise<string[]> {
  // Discover obsidian's FULL advertised capability surface from the vessel registry
  // so the substrate knows + can dispatch every shape obsidian actually offers
  // (the keystone of "understand how to use obsidian"). Falls back to the static
  // list only if the registry is unreachable.
  let shapes: string[] = DISCOVERY_PROXY_SHAPE_FALLBACK;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    let r: Response;
    try {
      r = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
        body: JSON.stringify({ pointer: { type: "vesselRegistry" } }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    const j = await r.json() as { content?: { vessels?: Array<{ shapes?: string[]; endpoint?: string; resolve_endpoint?: string }> } };
    const vessels = j?.content?.vessels ?? [];
    // Register a discovery-routed proxy for EVERY cross-vessel shape (not just
    // obsidian:) so the executor can dispatch any resolver the substrate
    // advertises — analysis-vessel problem_detection, concept-db, etc. This is
    // what lets a bridge-authored activity (auto-bridge-<X>) genuinely RUN: the
    // proxy POSTs to the vessel's resolve_endpoint — the SAME path author_producer
    // validates against, so execute-path matches validate-path. Capture each
    // shape's endpoint HERE (the registry carries it; the per-resolve
    // vesselCapability lookup returns null).
    const all = new Set<string>();
    for (const v of vessels) {
      const ep = typeof v.endpoint === "string" ? v.endpoint.replace(/\/+$/, "") : "";
      const rp = v.resolve_endpoint || "/resolve";
      for (const s of (v.shapes ?? [])) {
        if (typeof s === "string" && s) {
          all.add(s);
          if (ep) shapeEndpointMap.set(s, { endpoint: ep, resolvePath: rp });
        }
      }
    }
    if (all.size > 0) {
      shapes = [...all];
      discoveredProxyShapes = shapes;
      console.log(`[goal-host-vessel] discovered cross-vessel capability surface from registry: ${shapes.length} shapes`);
    }
  } catch (err) {
    console.warn(`[goal-host-vessel] cross-vessel shape discovery failed, using fallback (${DISCOVERY_PROXY_SHAPE_FALLBACK.length}): ${(err as Error).message}`);
  }
  const added: string[] = [];
  for (const shape of shapes) {
    if (registeredProxyShapes.has(shape)) continue;
    // Only fill GENUINELY cross-vessel gaps — skip shapes goal-host already
    // resolves locally (built-in or dev-vessel proxy) so we never shadow them.
    try { if (host.runtime.resolvers.get(shape)) { registeredProxyShapes.add(shape); continue; } } catch { /* no get → proceed */ }
    const resolver = buildDiscoveryProxyResolver(shape);
    host.runtime.resolvers.register(resolver as unknown as Parameters<typeof host.runtime.resolvers.register>[0]);
    registeredProxyShapes.add(shape);
    added.push(shape);
  }
  if (added.length > 0) {
    console.log(`[goal-host-vessel] discovery-proxy registration: +${added.length} cross-vessel shapes — ${added.join(", ")}`);
  }
  return added;
}

/**
 * Idempotent registration of development-vessel proxy resolvers.
 *
 * Fetches /shapes from dev-vessel, diffs against the currently-registered set,
 * and registers proxies for any new shapes (both bare and `development-vessel:`
 * qualified). Existing proxies are left alone — re-registration would be safe
 * but the diff avoids redundant work.
 *
 * Called at startup AND reactively from the vessel-registration WS subscriber
 * whenever a `vessel.registered` event fires for the dev-vessel identity. Per
 * openspec/changes/2026-05-27-neutral-emitter-lifecycle-bus
 * proxy-resolver-reactive-registration capability. Dissolves F-129 (proxy
 * registration race when goal-host restarts before dev-vessel is up).
 */
async function registerDevVesselProxies(): Promise<{ added: string[]; total: number }> {
  // ITER-4 fix: manual AbortController + clearTimeout + drain body.
  const shapesCtrl = new AbortController();
  const shapesTimer = setTimeout(() => shapesCtrl.abort(), 5_000);
  try {
    const r = await fetch(`${DEV_VESSEL_ENDPOINT}/shapes`, {
      signal: shapesCtrl.signal,
    });
    clearTimeout(shapesTimer);
    if (!r.ok) {
      try { await r.body?.cancel(); } catch { /* swallow */ }
      console.warn(`[goal-host-vessel] dev-vessel /shapes HTTP ${r.status} — proxy resolvers not registered yet`);
      return { added: [], total: registeredProxyShapes.size };
    }
    const body = await r.json() as { shapes?: string[] };
    const shapes: string[] = Array.isArray(body.shapes) ? body.shapes : [];
    if (shapes.length === 0) {
      console.warn("[goal-host-vessel] dev-vessel /shapes returned empty list");
      return { added: [], total: registeredProxyShapes.size };
    }

    const added: string[] = [];
    for (const shape of shapes) {
      if (registeredProxyShapes.has(shape)) continue;
      const resolver = buildProxyResolver(shape);
      // Cast: the proxy resolve fn uses a loose Record-typed context for
      // forward-compat with engine context shape evolution. The runtime
      // Resolver interface in ias-executor-ts is structurally compatible.
      host.runtime.resolvers.register(resolver as unknown as Parameters<typeof host.runtime.resolvers.register>[0]);
      host.runtime.resolvers.register({ ...resolver, id: `development-vessel:${shape}` } as unknown as Parameters<typeof host.runtime.resolvers.register>[0]);
      registeredProxyShapes.add(shape);
      added.push(shape);
    }

    if (added.length > 0) {
      console.log(
        `[goal-host-vessel] proxy registration: +${added.length} new shapes ` +
          `(now ${registeredProxyShapes.size} total) — ${added.slice(0, 5).join(", ")}` +
          (added.length > 5 ? `, ...` : ""),
      );
    }
    return { added, total: registeredProxyShapes.size };
  } catch (err) {
    clearTimeout(shapesTimer);
    console.warn(`[goal-host-vessel] failed to register dev-vessel proxies: ${(err as Error).message}`);
    return { added: [], total: registeredProxyShapes.size };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reactive vessel-registration subscriber (openspec proxy-resolver-reactive-registration)
//
// Subscribes to activity-api's WS bus and listens for `vessel.registered` events.
// When the dev-vessel re-registers (after restart, or for the first time when
// goal-host beat it to startup), triggers a debounced re-fetch + diff-and-register
// of dev-vessel proxy resolvers. This is the architectural antidote to F-129.
// ─────────────────────────────────────────────────────────────────────────────

const DEV_VESSEL_ID_PATTERN = /^development-vessel(-|$)/;
const REGISTRATION_DEBOUNCE_MS = 500;
let registrationDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let busWsClient: WebSocket | null = null;
let busReconnectDelay = 1_000;
const BUS_RECONNECT_MAX_DELAY = 30_000;

function startVesselRegistrationSubscriber(): void {
  // Convert http://... to ws://... for the WS endpoint
  const wsEndpoint = ACTIVITY_API_ENDPOINT.replace(/^http/, "ws") + "/ws";

  function connect(): void {
    try {
      busWsClient = new WebSocket(wsEndpoint);
    } catch (err) {
      console.warn(`[goal-host-vessel] WS subscriber connect failed: ${(err as Error).message}`);
      scheduleReconnect();
      return;
    }

    busWsClient.addEventListener("open", () => {
      busReconnectDelay = 1_000; // reset backoff
      busWsClient?.send(JSON.stringify({ type: "authenticate", token: API_KEY }));
      // Catch-up: registrations could have happened while we were disconnected.
      // Re-run the diff-and-register once on reconnect.
      void registerDevVesselProxies();
    });

    busWsClient.addEventListener("message", (e: MessageEvent) => {
      // L2 instrumentation: capture frame size BEFORE JSON.parse (cheap).
      // This tells us whether WS frame bytes correlate with memory growth.
      // We also do a substring sniff for "vessel.registered" before parsing —
      // if not present, skip parse entirely (hypothesis #2 fix option A).
      let rawSize = 0;
      let rawText: string | undefined;
      try {
        if (typeof e.data === "string") {
          rawSize = e.data.length;
          rawText = e.data;
        } else if (e.data && typeof (e.data as { byteLength?: number }).byteLength === "number") {
          rawSize = (e.data as { byteLength: number }).byteLength;
        }
      } catch { /* size sniff is best-effort */ }

      // FIX OPTION A: cheap substring guard before allocating parsed object.
      // Bus broadcasts task.completed, lifecycle.*, etc. all of which include
      // large impulse / LLM bodies. Only vessel.registered events trigger work.
      // If rawText is not a string (binary frame) we keep the prior behavior
      // to avoid silently dropping events of unknown shape.
      if (rawText !== undefined && !rawText.includes('"vessel.registered"')) {
        recordMemSample("ws", rawSize, "filtered");
        return;
      }

      try {
        const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
        recordMemSample("ws", rawSize, typeof msg?.type === "string" ? msg.type : "?");
        if (msg?.type !== "vessel.registered") return;
        // 2.A.1: any vessel registration changes the substrate's resolver
        // topology — and therefore the state-signature inputs. Drop the cache
        // so the next dispatch re-computes.
        invalidateSignatureCache();
        const vesselId = msg.data?.vessel_id;
        if (typeof vesselId !== "string" || !DEV_VESSEL_ID_PATTERN.test(vesselId)) return;
        // Debounce: coalesce rapid re-registrations into one re-fetch.
        if (registrationDebounceTimer) clearTimeout(registrationDebounceTimer);
        registrationDebounceTimer = setTimeout(() => {
          registrationDebounceTimer = null;
          void registerDevVesselProxies();
        }, REGISTRATION_DEBOUNCE_MS);
      } catch {
        // ignore unparseable / non-event frames
      }
    });

    busWsClient.addEventListener("close", () => {
      scheduleReconnect();
    });

    busWsClient.addEventListener("error", () => {
      // Errors will also trigger close; let close handle reconnect.
    });
  }

  function scheduleReconnect(): void {
    // L1.4: close stale socket before nulling reference so listener closures
    // (which capture busSink/host/etc) are eligible for GC. Previously the
    // bare `busWsClient = null` left old sockets retained by their listeners.
    if (busWsClient) {
      try { busWsClient.close(); } catch { /* already closed */ }
      busWsClient = null;
    }
    setTimeout(connect, busReconnectDelay);
    busReconnectDelay = Math.min(busReconnectDelay * 2, BUS_RECONNECT_MAX_DELAY);
  }

  connect();
  console.log(`[goal-host-vessel] vessel-registration subscriber started → ${wsEndpoint}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery registration loop
// ─────────────────────────────────────────────────────────────────────────────

const discoveryLoop = new DiscoveryRegistrationLoop({
  discoveryEndpoint: DISCOVERY_ENDPOINT,
  vesselId: VESSEL_ID,
  vesselName: "Goal Host Vessel",
  shapes: [...SHAPES],
  resolveEndpoint: `http://127.0.0.1:${PORT}/resolve`,
  apiKey: API_KEY,
  port: PORT,
  systemVessel: true,
});

discoveryLoop.onUnhealthy(() => {
  console.warn(`[goal-host-vessel] discovery heartbeat failed 3×; vessel may be unreachable`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Request helpers
// ─────────────────────────────────────────────────────────────────────────────

async function handleRunGoal(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null) throw new Error("body must be an object");
    body = parsed as Record<string, unknown>;
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const goal = typeof body.goal === "string" ? body.goal : undefined;
  const operator = typeof body.operator === "string" && body.operator.length > 0 ? body.operator : undefined;
  const targetTemplateId = typeof body.targetTemplateId === "string" ? body.targetTemplateId : undefined;
  const variables = typeof body.variables === "object" && body.variables !== null
    ? (body.variables as Record<string, unknown>)
    : {};
  // Auto-populate `variables.goal` from the request's goal text when the caller
  // didn't already set it. Templates that interpolate `{{goal}}` (e.g. user-goal
  // terminal templates like summarize-and-emit-concept) rely on this — without
  // it, the LLM prompt receives the literal "{{goal}}" placeholder string and
  // produces useless output. Callers can override by setting variables.goal
  // explicitly. The seeded goal-impulse content carries the same text, but the
  // engine's variable-substitution pass only looks at accumulatedVariables, not
  // at impulse content.
  if (typeof body.goal === "string" && typeof variables.goal !== "string") {
    variables.goal = body.goal;
  }
  const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined;
  const expectedOutputShapes = Array.isArray(body.expected_output_shapes)
    ? (body.expected_output_shapes as string[]).filter((s) => typeof s === "string")
    : undefined;
  const parentExecutionId = typeof body.parent_execution_id === "string"
    ? body.parent_execution_id
    : undefined;
  const compositionChain = Array.isArray(body.composition_chain)
    ? (body.composition_chain as string[])
    : [];
  // Concept priors threaded into state-signature (Gap #1): when an upstream
  // task (e.g. concept_select_for_prompt) has identified the priors loaded
  // for this dispatch, surfacing them in the signature lets posteriors be
  // segmented by concept-conditioned environment. Accepts top-level
  // `loaded_concept_ids` or nested under variables; either form survives.
  let loadedConceptIds: string[] | undefined;
  if (Array.isArray(body.loaded_concept_ids)) {
    loadedConceptIds = (body.loaded_concept_ids as unknown[]).filter(
      (s): s is string => typeof s === "string",
    );
  } else if (Array.isArray((variables as Record<string, unknown>).loaded_concept_ids)) {
    loadedConceptIds = ((variables as Record<string, unknown>).loaded_concept_ids as unknown[])
      .filter((s): s is string => typeof s === "string");
  }

  if (!goal && !targetTemplateId) {
    return Response.json({ error: "goal or targetTemplateId is required" }, { status: 400 });
  }

  // D3 guard: cross-vessel invocations must carry parent_execution_id.
  const callerVessel = req.headers.get("x-caller-vessel");
  if (callerVessel && !parentExecutionId) {
    return Response.json(
      { error: "parent_execution_id required for cross-vessel goal dispatch (D3)" },
      { status: 400 },
    );
  }

  // Async dispatch: return 202+dispatchId immediately so the caller is not
  // subject to Bun's built-in 300s connection timeout. The caller polls
  // GET /executions/:dispatchId for the outcome.
  const dispatchId = crypto.randomUUID();
  pruneStore();
  const record: DispatchRecord = { dispatchId, startedAt: Date.now(), status: "running", goal: typeof goal === "string" ? goal : undefined, reached: null, operator };
  executionStore.set(dispatchId, record);
      if (!("dispatch_id" in variables)) variables.dispatch_id = dispatchId;

  // Auto-draft fallback: when caller provides a free-form goal but no
  // targetTemplateId, pre-check activity-api /recommend. If top candidate
  // score is below SUBSTRATE_AUTO_DRAFT_THRESHOLD, the catalogue has no fit
  // — dispatch the drafter to author one before the original goal runs. The
  // result is substrate creating new capability AS A SIDE EFFECT of trying
  // to accomplish something operational. Async (run inside the dispatch
  // promise) so the immediate 202 response isn't delayed.
  const autoDraft = async (): Promise<void> => {
    if (process.env.SUBSTRATE_AUTO_DRAFT_ENABLED === "0") return;
    if (!goal || targetTemplateId) return;
    const threshold = parseFloat(process.env.SUBSTRATE_AUTO_DRAFT_THRESHOLD ?? "0.3");
    try {
      const preRec = await fetch(`${ACTIVITY_API_ENDPOINT}/v2/activities/recommend`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}`,
        },
        body: JSON.stringify({ task_description: goal, ...(expectedOutputShapes?.length ? { expected_output_shapes: expectedOutputShapes } : {}) }),
      });
      if (!preRec.ok) {
        const errText = await preRec.text().catch(() => "");
        console.warn(`[goal-host-vessel] auto-draft pre-recommend HTTP ${preRec.status}: ${errText.slice(0, 200)}`);
        return;
      }
      console.log(`[goal-host-vessel] auto-draft pre-recommend OK for goal="${(goal as string).slice(0, 60)}"`);
      const data = await preRec.json() as { recommendations?: Array<{ template_id: string; score?: number }>; fallback_tier?: string };
      const recommendations = data.recommendations ?? [];
      const top = recommendations[0];
      const topScore = top?.score ?? 0;
      if (top && topScore >= threshold) return;
      // Exploration-floor routing (2026-06-18). Prior "Fix A" let any recommendation
      // (even top_score=0.000) preempt autoDraft, firing autoDraft only on
      // fallback_tier=refused — which almost never happens (fts_hybrid always returns
      // SOME exploration pick). Net effect: a NOVEL goal the catalogue cannot service
      // (e.g. a code-fix the substrate has no template for) ran an irrelevant
      // high-Thompson template instead of routing to the drafter — so raw run_goal
      // could never drive self-development. Restore the gap path with a floor: a pick
      // at/above SUBSTRATE_AUTO_DRAFT_EXPLORE_FLOOR is a plausible exploration and runs
      // via ias-executor; BELOW the floor there is no real fit, so fall through to
      // autoDraft and author new capability from the goal.
      const fallbackTier = data.fallback_tier ?? "none";
      const exploreFloor = parseFloat(process.env.SUBSTRATE_AUTO_DRAFT_EXPLORE_FLOOR ?? "0.1");
      if (top && topScore >= exploreFloor) {
        console.log(`[goal-host-vessel] auto-draft skipped: ${recommendations.length} exploration pick(s) available (top_score=${topScore.toFixed(3)} >= floor ${exploreFloor}, fallback_tier=${fallbackTier})`);
        return;
      }
      if (!top && fallbackTier !== "refused") {
        // No top recommendation but some tier returned something — not a hard empty.
        console.log(`[goal-host-vessel] auto-draft skipped: fallback_tier=${fallbackTier} (not refused), no template selected but not a hard gap`);
        return;
      }
      // top exists but top_score < floor (no real fit), OR no top and refused → autoDraft.
      console.log(`[goal-host-vessel] auto-draft trigger: goal="${(goal as string).slice(0, 80)}" fallback_tier=refused (top_score=${topScore})`);
      const triggerStart = Date.now();
      const candidatesConsidered = recommendations.slice(0, 5).map((r) => ({ id: r.template_id, score: r.score ?? 0 }));
      void emitAuthoringDecision("auto_draft_triggered",
        `top_score=${topScore} < threshold=${threshold} for goal: ${(goal as string).slice(0, 120)}`,
        {
          dispatchId,
          goal: (goal as string).slice(0, 200),
          topScore,
          thresholdValue: threshold,
          candidatesConsidered,
          stateSignatureHash: record.stateSignature?.signature_hash ?? null,
          timestamp: new Date().toISOString(),
        });
      // PRE-DRAFTER reuse lookup (LLM intent-match): before authoring a new
      // template, ask llm-resolver-vessel whether any prior gap-closing:auto-*
      // template would truly answer this goal. Replaces the earlier bag-of-
      // tokens overlap heuristic, which fired false positives whenever two
      // unrelated goals shared substrate-domain keywords (e.g. "substrate",
      // "vessel", "trace"). The LLM call is one-shot, low-cost (haiku,
      // max_tokens=10, no tools), 15s-bounded, and crash-safe — any error
      // falls through to drafter dispatch.
      if (process.env.SUBSTRATE_REUSE_LLM_ENABLED !== "0") {
        try {
          const reuseList = await fetch(`${ACTIVITY_API_ENDPOINT}/v2/activities/templates?q=gap-closing&limit=10`, {
            headers: { Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}` },
          });
          if (reuseList.ok) {
            const rl = await reuseList.json() as { templates?: Array<{ id: string; name?: string; description?: string; proposed?: boolean }> };
            const autoCands = (rl.templates ?? []).filter((t) => typeof t.id === "string" && /gap-closing:auto-/.test(t.id));
            // Rank by created_at unix-ms embedded as the second number in
            // `gap-closing:auto-<ts1>-<rand>-<ts2>`; fall back to first number.
            const idTs = (id: string): number => {
              const nums = id.match(/\d{10,}/g) ?? [];
              const parsed = nums.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
              return parsed.length > 1 ? parsed[1] : (parsed[0] ?? 0);
            };
            const topN = autoCands.sort((a, b) => idTs(b.id) - idTs(a.id)).slice(0, 5);
            if (topN.length > 0) {
              const listing = topN.map((t, i) => `${i + 1}. name: ${(t.name ?? "(unnamed)").slice(0, 120)}; description: ${(t.description ?? "(none)").slice(0, 240)}`).join("\n");
              const prompt = `Decide: REUSE existing template or AUTHOR new for this goal.\n\nGoal: ${goal}\n\nCandidates:\n${listing}\n\nPick the NUMBER of a candidate whose name/description is a near-paraphrase of the goal (same subject AND same artifact, just reworded).\nYES: goal "audit anomalous-duration dispatches" + candidate "Audit dispatches with anomalous duration" → match. Goal "show alpha by template" + candidate "Report alpha distribution per template" → match.\nNO: goal "Thompson alpha distribution" + candidate "Audit anomalous-duration dispatches" → NONE (different subject). Goal "stale promoted templates" + candidate "Audit anomalous-duration dispatches" → NONE.\nIf no candidate shares the goal's core subject, answer NONE.\n\nReply ONLY a digit (1-${topN.length}) or NONE.`;
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 15000);
              try {
                const llmRes = await fetch(`${LLM_VESSEL_ENDPOINT}/resolve`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}` },
                  body: JSON.stringify({ type: "llm_completion", prompt, model: "claude-haiku-4-5-20251001", max_tokens: 10 }),
                  signal: ctrl.signal,
                });
                clearTimeout(timer);
                if (llmRes.ok) {
                  const lr = await llmRes.json() as { resolved?: boolean; content?: string };
                  const ans = (lr.content ?? "").trim().match(/^\d+/)?.[0];
                  const idx = ans ? parseInt(ans, 10) : NaN;
                  if (Number.isFinite(idx) && idx >= 1 && idx <= topN.length) {
                    const picked = topN[idx - 1];
                    authoredTemplateId = picked.id;
                    console.log(`[goal-host-vessel] auto-draft REUSE (LLM): selected candidate ${idx} "${picked.name ?? picked.id}" for goal="${(goal as string).slice(0, 80)}"`);
                    void emitAuthoringDecision("auto_draft_reused",
                      `reused ${picked.id} (cand ${idx}/${topN.length}) for goal: ${(goal as string).slice(0, 120)}`,
                      {
                        dispatchId,
                        goal: (goal as string).slice(0, 200),
                        topScore,
                        thresholdValue: threshold,
                        candidatesConsidered: topN.map((t) => ({ id: t.id, name: t.name })),
                        selectedCandidateIdx: idx,
                        authoredTemplateId: picked.id,
                        durationMs: Date.now() - triggerStart,
                        stateSignatureHash: record.stateSignature?.signature_hash ?? null,
                        timestamp: new Date().toISOString(),
                      });
                    return;
                  }
                  console.log(`[goal-host-vessel] auto-draft REUSE (LLM): no candidate selected (raw="${(lr.content ?? "").trim().slice(0, 20)}"); proceeding to author`);
                  // v2 mitosis: drop candidate refs + sync GC to release retained closures.
                  topN.length = 0;
                  try { (globalThis as unknown as { Bun?: { gc?: ((b: boolean) => number) | undefined; } | undefined; }).Bun?.gc?.(true); } catch {}
                }
              } catch (llmErr) {
                clearTimeout(timer);
                console.warn(`[goal-host-vessel] auto-draft reuse LLM call failed; falling through to author:`, llmErr instanceof Error ? llmErr.message : llmErr);
              }
            }
          }
        } catch (reuseErr) {
          console.warn(`[goal-host-vessel] auto-draft reuse lookup skipped:`, reuseErr instanceof Error ? reuseErr.message : reuseErr);
        }
      }
      const scenarioId = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Drafter tasks 6/8 (extract_required_shapes + register_variant) require
      // expected_emergence.activity_signature.output_shapes_must_include to be
      // a non-empty array. Operator-curated fp-* scenarios always set this;
      // auto-synthesized scenarios previously omitted the field and json_path_extract
      // returned structuredError, halting the drafter chain after task 5. Synthesize
      // a placeholder shape derived from the scenario id so the chain advances
      // through proposal write + variant registration. The registered variant's
      // outputShapes is set by output_shapes_override using this value.
      const shortId = scenarioId.replace(/[^A-Za-z0-9]/g, "").slice(-8);
      const outputShapesMustInclude =
        Array.isArray(expectedOutputShapes) && expectedOutputShapes.length > 0
          ? expectedOutputShapes
          : [`autoDraftedOutput_${shortId}`];
      // Resolver-dispatch contract for the auto-draft drafter. The remediation
      // author (draft-activity-from-pattern, see topology_hint below) has always
      // received this; the FIRST-attempt auto-draft path did not — so it authored
      // tasks with raw, advertised-but-non-dispatchable resolver ids (e.g.
      // `llm_completion`, which goal-host's proxy sends to llm-resolver-vessel as
      // pointer.prompt while that vessel reads a body-level prompt → silent
      // dispatch failure → HOLLOW). discoveredProxyShapes is the full registry
      // surface; we EXCLUDE the raw llm shapes and steer all reasoning to the
      // dispatch wrapper `llm_completion_dispatch` (which translates the envelope).
      const NON_DISPATCHABLE_RAW = new Set(["llm_completion", "llmCompletion"]);
      const dispatchableResolverIds = [...new Set([
        ...discoveredProxyShapes.filter((s) => !NON_DISPATCHABLE_RAW.has(s)),
        "llm_completion_dispatch",
      ])];
      const scenario = {
        id: scenarioId,
        mode_class: "auto",
        stage: "synthesis",
        outcome_class: "gap",
        title: `Auto-synthesized gap: ${(goal as string).slice(0, 80)}`,
        description: `Goal-host /recommend returned top_score=${topScore} (< ${threshold}) for goal: "${goal}". Substrate catalogue has no fit. Auto-synthesized scenario so drafter can author a closing activity. This is the substrate creating new functionality as a side effect of trying to do something else (the operator's actual goal).`,
        goal_text: goal,
        expected_input_shapes: [],
        expected_output_shapes: expectedOutputShapes ?? [],
        cited_concepts: ["concept_9ldsmRgqSTd5"],
        auto_draft_for_dispatch: dispatchId,
        // RESOLVER DISPATCH CONTRACT — the drafter MUST honor this. A task whose
        // resolver id is not in `use_only_these_resolver_ids` fails at dispatch.
        resolver_contract: {
          use_only_these_resolver_ids: dispatchableResolverIds,
          reasoning_resolver: "llm_completion_dispatch",
          forbidden_raw_aliases: { llm_completion: "llm_completion_dispatch", llmCompletion: "llm_completion_dispatch" },
          slot_binding_rule: "To pass one task's output into a later task, the PRODUCER task must declare outputImpulses:[\"<slot>\"] and the CONSUMER task must declare inputImpulses:[\"<slot>\"] AND reference it in its config/prompt as {{impulse:<slot>}}. Every {{impulse:<slot>}} you write MUST have a producing task that declares that exact slot in outputImpulses, or it will not bind.",
          note: "Every task.resolver MUST be one of use_only_these_resolver_ids. For ANY LLM reasoning/synthesis use llm_completion_dispatch (NEVER raw llm_completion / llmCompletion). Put each resolver's inputs in task.config — those keys become the pointer fields POSTed to the owning vessel.",
        },
        expected_emergence: {
          class: "new",
          activity_signature: {
            input_shapes_intersect: [],
            output_shapes_must_include: outputShapesMustInclude,
            tags_pattern: "substrate.auto.draft.*",
          },
          minimum_thompson_alpha: 1,
        },
      };
      const fsWriteBody = JSON.stringify({
        impulse: {
          pointer: {
            type: "fs_write",
            path: `/workspace/validation/failure-modes/scenarios/${scenarioId}.json`,
            content: JSON.stringify(scenario, null, 2),
          },
        },
      });
      await fetch(`${process.env.DEVELOPMENT_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090"}/v2/impulses/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}`,
        },
        body: fsWriteBody,
      });
      console.log(`[goal-host-vessel] auto-draft: scenario ${scenarioId}.json written; dispatching draft-gap-closing-activity`);
      try {
        await host.runGoal(`auto-draft for gap: ${(goal as string).slice(0, 60)}`, {
          targetTemplateId: "activity:⟨development-vessel:draft-gap-closing-activity⟩",
          variables: {
            scenario_id: scenarioId,
            report_path: `/workspace/validation/failure-modes/scenarios/${scenarioId}.json`,
            proposals_dir: "/workspace/proposals",
            scenarios_dir: "/workspace/validation/failure-modes/scenarios",
          },
          tags: ["substrate.auto.draft", `auto_draft_for_dispatch:${dispatchId}`],
        });
        console.log(`[goal-host-vessel] auto-draft: drafter completed for scenario ${scenarioId}`);
        // Find the just-authored template + promote it + capture its id so the
        // ORIGINAL goal runs against the substrate's freshly-authored capability
        // instead of falling back through recommend to a generic attractor.
        // Mitigation for the mode-collapse identified by the consistency batch
        // (validation/findings/substrate-consistency/2026-06-01T22-19-05Z-…).
        try {
          // FTS index lags template-create. List recent templates and
          // filter for the scenario_id substring in id — substrate-authored
          // templates have the pattern `gap-closing:<scenario_id>-<timestamp>`.
          const listRes = await fetch(
            `${ACTIVITY_API_ENDPOINT}/v2/activities/templates?q=gap-closing&limit=10`,
            { headers: { Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}` } },
          );
          if (listRes.ok) {
            const list = await listRes.json() as { templates?: Array<{ id: string }> };
            const authored = (list.templates ?? []).find((t) =>
              typeof t.id === "string" && t.id.includes(scenarioId)
            );
            if (authored?.id) {
              authoredTemplateId = authored.id;
              // BUILD LINT — verify the freshly-authored template is THEORETICALLY
              // VALID (dispatchable resolver ids + coherent {{impulse:slot}}
              // mappings) before promoting it, and auto-repair the known raw-llm
              // alias in place. This is structural validity only — it does NOT
              // assert the activity will reach the operator's goal. The auto-draft
              // path used to promote non-dispatchable chains that then silently
              // produced HOLLOW results; the lint makes the defect visible + fixes
              // the one mechanical case (llm_completion → llm_completion_dispatch).
              const lint = await lintAndRepairAuthoredTemplate(authored.id, dispatchId, goal as string);
              if (lint.invalidResolvers.length > 0 || lint.unboundSlots.length > 0) {
                console.warn(`[goal-host-vessel] auto-draft LINT flagged ${authored.id}: invalidResolvers=[${lint.invalidResolvers.join(", ")}] unboundSlots=[${lint.unboundSlots.join(", ")}]`);
              }
              console.log(`[goal-host-vessel] auto-draft: authored ${authored.id}; promoting + overriding targetTemplateId (lint: repaired=${lint.repaired.length}, invalid=${lint.invalidResolvers.length}, unboundSlots=${lint.unboundSlots.length})`);
              await fetch(
                `${ACTIVITY_API_ENDPOINT}/v2/activities/templates/${encodeURIComponent(authored.id)}/promote`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}`,
                    "Content-Type": "application/json",
                  },
                  body: "{}",
                },
              );
              void emitAuthoringDecision("auto_draft_authored",
                `authored + promoted ${authored.id} for goal: ${(goal as string).slice(0, 120)}`,
                {
                  dispatchId,
                  goal: (goal as string).slice(0, 200),
                  topScore,
                  thresholdValue: threshold,
                  scenarioId,
                  authoredTemplateId: authored.id,
                  selectedCandidateIdx: "NONE",
                  durationMs: Date.now() - triggerStart,
                  stateSignatureHash: record.stateSignature?.signature_hash ?? null,
                  timestamp: new Date().toISOString(),
                });
            }
          }
        } catch (promoteErr) {
          console.warn(`[goal-host-vessel] auto-draft: promote step skipped:`, promoteErr instanceof Error ? promoteErr.message : promoteErr);
        }
      } catch (drafterErr) {
        console.error(`[goal-host-vessel] auto-draft: drafter error:`, drafterErr);
      }
    } catch (recErr) {
      console.warn(`[goal-host-vessel] auto-draft skipped:`, recErr instanceof Error ? recErr.message : recErr);
    }
  };
  // Captured from autoDraft so main runGoal can use the freshly-authored
  // template instead of an unsuitable attractor.
  let authoredTemplateId: string | undefined;

  (async () => {
    // Reason plane: caller-owned walk decision-log sink, attached to the record
    // in both the success and failure paths so GET /executions/:id can surface it.
    const walkStepSink: string[] = [];
    try {
      // Compute state-space signature BEFORE dispatch so the trace records
      // the environment in which template selection happened. The hash is
      // appended to `tags` as `state_signature:<hash>`; the full body is
      // attached to the dispatch record for later inspection.
      // 2.A.1: use cached signature (TTL SIGNATURE_CACHE_MS, default 60s)
      // so multi-task dispatches don't re-trigger dev-vessel's full /proc +
      // recent-trace + catalogue compute per dispatch. Reduces the dispatch-
      // setup memory churn that dominates goal-host's per-dispatch RSS delta.
      const stateSignature = await getCachedStateSignature(loadedConceptIds);
      record.stateSignature = stateSignature;
      const sigTag = stateSignature?.signature_hash
        ? [`state_signature:${stateSignature.signature_hash}`]
        : [];
      // Wire 1 (2026-06-03): propagate MITOSIS_VERSION_ID into the trace so
      // mitosis_evaluate can segment AET rows by version. When goal-host runs
      // as part of a mitosis-spawned vessel, the systemd unit injects
      // MITOSIS_VERSION_ID + MITOSIS_BASE_VESSEL. Surfaced as trace tags
      // (open schema) — keeps the change zero-API-surface while making the
      // version observable to the differential evaluator.
      const mitosisVersionId = process.env["MITOSIS_VERSION_ID"];
      const mitosisBaseVessel = process.env["MITOSIS_BASE_VESSEL"];
      const mitosisTags = mitosisVersionId
        ? [
            `mitosis_version_id:${mitosisVersionId}`,
            ...(mitosisBaseVessel ? [`mitosis_base_vessel:${mitosisBaseVessel}`] : []),
          ]
        : [];
      // 2.C.5: trace metadata — record which dispatcher produced this trace.
      // goal-host is the legacy full-machinery dispatcher; light-dispatch-vessel
      // sets the equivalent tag on its own traces. boredom-vessel uses these
      // tags downstream to build per-dispatcher Thompson posteriors.
      const dispatcherTag = ["dispatcher_used:goal-host"];
      const operatorTag = operator ? [`operator:${operator}`] : [];
      const effectiveTags = [...(tags ?? []), ...sigTag, ...mitosisTags, ...dispatcherTag, ...operatorTag];

      // Async /run-goal is the agent (MCP) + boredom dispatch surface. It uses the
      // SHARED runGoalWithRecovery (same loop as /resolve, no duplication) and can
      // recover more deeply (maxAttempts 3) since it is polled, not timeout-bound.
      //
      // autoDraft is now DEFERRED into authorFallback (2026-06-29): it runs only if
      // the shape-graph walk takes 0 feasible steps. Previously it ran eagerly here
      // and its authored id was passed as firstTarget — which SUPPRESSED the walk
      // (a set firstTarget skips the walk block), so an outward read-capability goal
      // (analysis / concept) never reached the vessel-resolve satisfier and fell into
      // slow from-scratch drafting. We pass only the CALLER's pin as firstTarget so
      // the walk runs; the walk's satisfier routes outward goals to their vessel.
      const callerPinnedTarget = typeof targetTemplateId === "string" && targetTemplateId.length > 0;
      const authorFallback = async (): Promise<string | undefined> => {
        await autoDraft();
        if (authoredTemplateId) {
          console.log(`[goal-host-vessel] /run-goal: walk took 0 steps — using auto-authored template ${authoredTemplateId} for goal`);
        } else if (goal) {
          void emitAuthoringDecision("auto_draft_fallback_recommend",
            `no targetTemplateId; falling through to /recommend for goal: ${goal.slice(0, 120)}`,
            {
              dispatchId,
              goal: goal.slice(0, 200),
              authoredTemplateId: null,
              selectedCandidateIdx: "NONE",
              stateSignatureHash: stateSignature?.signature_hash ?? null,
              timestamp: new Date().toISOString(),
            });
        }
        return authoredTemplateId;
      };
      const seek = await runGoalWithRecovery(goal, {
        firstTarget: targetTemplateId,
        callerPinned: callerPinnedTarget,
        authorFallback,
        maxAttempts: 3,
        variables,
        tags: effectiveTags,
        parentExecutionId,
        compositionChain,
        expectedOutputShapes,
        surface: "/run-goal",
        stepSink: walkStepSink,
      });
      record.status = seek.status;
      // Honest goal-reach verdict, threaded up from the walk's GoalReachVerdict
      // through GoalSeekResult.reached — distinct from status (template exit).
      record.reached = seek.reached;
      record.walkLog = walkStepSink;
      record.executionId = seek.executionId ?? seek.result?.trace?.id;
      record.selectedTemplateId = seek.selectedTemplateId;
      (record as { attempts?: number }).attempts = seek.attempts;
      (record as { completionShapes?: string[] | null }).completionShapes = seek.completionShapes;
      if (seek.goalReachReason) record.goalReachReason = seek.goalReachReason;
    } catch (err) {
      record.status = "failed";
      // A thrown dispatch never produced a reach verdict — the goal was not reached.
      record.reached = false;
      record.error = (err as Error).message;
      if (walkStepSink.length) record.walkLog = walkStepSink;
      console.error("[goal-host-vessel] async /run-goal error:", err);
      // Detection (operator-goal observability). When an OPERATOR-originated
      // dispatch fails because nothing in the catalogue could serve it (recommend
      // refused + auto-draft did not converge), that is the strongest signal of a
      // real capability gap: a human asked for something the substrate cannot yet
      // do and got nothing back. Today that failure is only a swallowed log line +
      // a fire-and-forget auto-draft that drafts the wrong shape, so operator goals
      // go unserved invisibly. Emit a high-priority, class-deduped substrateGap so
      // (a) "operator goals going unserved" is MEASURABLE, and (b) the value-directed
      // drafter prioritises real operator goals over synthetic ones. Synthetic
      // auto-draft dispatches are excluded (they have their own loop).
      try {
        const msg = (err as Error).message ?? "";
        const isOperator = Array.isArray(tags) && tags.some((t) =>
          typeof t === "string" && t.startsWith("dispatcher:") && !t.includes("auto"));
        const isUnservable = /no template id returned|fallback_tier=refused/i.test(msg);
        if (isOperator && isUnservable && typeof goal === "string") {
          const dispatcher = (tags as string[]).find((t) =>
            typeof t === "string" && t.startsWith("dispatcher:")) ?? "dispatcher:unknown";
          // Dedup by goal CLASS so repeated identical operator goals collapse to one
          // gap whose recurrence the substrate can count (convergence-blindness
          // detector: a stable gap id lets a picker/escalator see "still open after
          // N drafts") rather than flooding the backlog.
          const goalClass = goal.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
          const gapId = `operator_goal_unservable:${goalClass.replace(/[^a-z0-9]+/g, "_").slice(0, 64)}`;
          const gap = {
            id: gapId,
            category: "operator_goal_unservable",
            source: "operator_dispatch",
            summary: `An operator dispatched the goal "${goal.slice(0, 160)}" via ${dispatcher} but the substrate could not serve it: recommend refused and auto-draft did not converge. This is a REAL capability gap — a human is waiting and got nothing. The substrate should author an activity that serves this goal class` +
              (Array.isArray(expectedOutputShapes) && expectedOutputShapes.length
                ? ` (expected output shapes: ${expectedOutputShapes.join(", ")}).` : "."),
            detected_at: new Date().toISOString(),
            status: "open",
            goal_text: goal.slice(0, 400),
            expected_output_shapes: Array.isArray(expectedOutputShapes) ? expectedOutputShapes : [],
            classification_metadata: {
              detector: "goal_host_operator_dispatch_failure",
              gap_class: "operator_goal_unservable",
              dispatcher,
              dispatch_id: dispatchId,
              error: msg.slice(0, 200),
              priority_hint: "high",
            },
          };
          await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}` },
            body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap } } }),
            signal: AbortSignal.timeout(8000),
          });
          console.log("[goal-host-vessel] operator_goal_unservable gap emitted: " + gapId);
        try {
          const dr = await fetch(DISCOVERY_ENDPOINT + "/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: "ApiKey " + API_KEY } : {}) },
            body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "obsidian:write_note" } }),
            signal: AbortSignal.timeout(5000),
          });
          const dj = await dr.json() as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string }> } };
          const wv = dj?.content?.vessels?.[0];
          if (wv?.endpoint) {
            const notePath = "Substrate/Unservable/" + gapId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) + ".md";
            const noteBody = "# I could not serve this goal\n\n**Goal:** " + goal.slice(0, 300) + "\n\n**Why:** the substrate found no activity that serves this goal class (recommend refused and auto-draft did not converge). A capability gap has been filed (" + gapId + ") and the substrate will attempt to author an activity for it.\n";
            await fetch(wv.endpoint.replace(/\/+$/, "") + (wv.resolve_endpoint || "/resolve"), {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: "ApiKey " + API_KEY } : {}) },
              body: JSON.stringify({ impulse: { pointer: { type: "obsidian:write_note", path: notePath, content: noteBody, dispatch_id: dispatchId, goal: goal.slice(0, 200), reached: false } } }),
              signal: AbortSignal.timeout(8000),
            });
            console.log("[goal-host-vessel] operator_goal_unservable vault note written: " + notePath);
          }
        } catch { /* vault surface unreachable — the substrateGap above is the durable record */ }
          // Remediation routing (convergence). A runtime-capability gap needs a
          // RUNTIME ACTIVITY (read→reason→write composing the vessel's own
          // resolvers, output = expectedOutputShapes), NOT a code-fix patch_proposal.
          // The code-fix drafter (draft-gap-closing-activity) is hardwired to
          // patch_proposal and cannot serve it. Route to the real-chain author
          // (draft-activity-from-pattern), which composes forward from a hand-built
          // cluster spec. PROVEN 2026-06-15: this produced
          // proposed_pattern_authored_reorganize_daily_notes_by_topic
          // (obsidian:workspace_state → llm → obsidian:write_note, output obsidian:note).
          try {
            const patternId = gapId.replace(/[^a-z0-9]+/gi, "_").slice(0, 64);
            const outShapes = Array.isArray(expectedOutputShapes) && expectedOutputShapes.length
              ? expectedOutputShapes : ["obsidian:note"];
            const cluster = {
              pattern_id: patternId,
              summary: `An operator dispatched the goal "${goal.slice(0, 120)}" but the substrate has no template that serves it. Author the smallest REAL resolver chain that performs this work and yields ${outShapes.join(", ")}. Use the vessel's own typed resolvers for those shapes (resolvers live where the data lives).`,
              observation_window: "operator_dispatch",
              n_observations: 1,
              n_contrast_examples: 0,
              expected_outputs: outShapes,
              example_trace_ids: [],
              contrast_trace_ids: [],
              producing_activities: [],
              topology_hint: `Compose REAL resolver calls that READ the relevant state, REASON over it (llm_completion_dispatch), and WRITE the result. The LAST task MUST emit one of [${outShapes.join(", ")}] so executing the template serves the operator's goal. Use ONLY these EXACT resolver ids for vessel operations — do NOT invent variants (e.g. there is no obsidian:read_note or obsidian:write_frontmatter; use obsidian:note to read and obsidian:write_note to write a whole note including its frontmatter): ${discoveredProxyShapes.join(", ")}, llm_completion_dispatch. An authored task whose resolver id is not in that list will fail at dispatch. To PERFORM AN ACTION in the app (beyond reading/writing notes — e.g. open a view, toggle a panel, run a built-in command), FIRST read obsidian:command_catalog (config {permission_filter:["navigate"],query:"<keyword>"}) to discover the exact command_id, then dispatch obsidian:execute_command (config {command_id:"<id>", granted_classes:["read","navigate"]}). execute_command REFUSES any command whose authority class is not in granted_classes and any destructive/irreversible command, so default granted_classes to ["read","navigate"] unless the operator goal clearly authorises mutation. CONFIG CONTRACTS (use exactly): obsidian:write_note REQUIRES config {path:"Substrate/<descriptive-name>.md", content:"{{<prior_task>_text}}"} — path is MANDATORY, must start with "Substrate/" and end with ".md"; there is NO note_type or auto-path field, always set an explicit path (writes are hard-restricted to the Substrate/ namespace). obsidian:write_note is also how you produce any "note"/"daily_note"/"index" output — there is no separate daily-note writer. VERIFY YOUR OWN OUTPUT — it is easy to hallucinate success: after the write task, ALWAYS append a FINAL task with resolver obsidian_verify_output and config {path:"<the EXACT path you wrote>", request:"<the operator goal>", strict:true}. With strict:true the activity FAILS unless the written note independently exists, is substantive (not a stub), is not a self-undermining non-answer, and is on-topic — so a hallucinated "I need more data" completion is recorded as a FAILURE, not a success. The expected output is not real until this verification passes. Do NOT author a read_scenario→analyse→write-a-Proposal scaffold; emit no *Proposal output.`,
              deny_list: ["activityTemplateProposal", "patch_proposal", "read_scenario"],
              bridge_source: "operator_goal_unservable",
            };
            await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}` },
              body: JSON.stringify({ impulse: { pointer: { type: "fs_write", path: `/workspace/patterns/${patternId}.json`, content: JSON.stringify(cluster, null, 2) } } }),
              signal: AbortSignal.timeout(8000),
            });
            // Dispatch the real-chain author (async; do not await its completion here).
            void fetch(`${GOAL_HOST_ENDPOINT}/run-goal`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}` },
              body: JSON.stringify({
                goal: `author runtime activity for operator goal: ${goal.slice(0, 80)}`,
                targetTemplateId: "development-vessel:draft-activity-from-pattern",
                variables: { pattern_id: patternId, patterns_dir: "/workspace/patterns", source: "operator_goal_unservable" },
              }),
            }).catch(() => { /* best-effort */ });
            console.log(`[goal-host-vessel] operator_goal_unservable → real-chain author dispatched (pattern ${patternId})`);
          } catch (routeErr) {
            console.warn("[goal-host-vessel] operator_goal_unservable author-route failed:",
              routeErr instanceof Error ? routeErr.message : routeErr);
          }
        }
      } catch (gapErr) {
        console.warn("[goal-host-vessel] operator_goal_unservable gap emit failed:",
          gapErr instanceof Error ? gapErr.message : gapErr);
      }
    }
  })();

  return Response.json({ dispatchId, status: "running" }, { status: 202 });
}

async function handleResolve(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null) throw new Error("body must be an object");
    body = parsed as Record<string, unknown>;
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  // Support both direct { type, goal, ... } and impulse-wrapper
  // { impulse: { pointer: { type, goal, ... } } }. The impulse-wrapper form is
  // the compliant impulse-contract path used by discovery-routed and
  // MCP-fronted dispatches; the top-level form is the legacy convenience
  // shape. Each field falls back from top-level → impulse.pointer.
  const pointer = ((body.impulse as Record<string, unknown> | undefined)
    ?.pointer as Record<string, unknown> | undefined) ?? {};

  const type = (body.type as string | undefined) ?? (pointer.type as string | undefined);

  if (type !== "goal_execution" && type !== "activity_execution") {
    return Response.json(
      { error: `unknown shape '${type}'; supported: goal_execution, activity_execution` },
      { status: 404 },
    );
  }

  const goal = typeof body.goal === "string" ? body.goal
    : typeof pointer.goal === "string" ? pointer.goal
    : undefined;
  const targetTemplateId = typeof body.target_template_id === "string" ? body.target_template_id
    : typeof pointer.target_template_id === "string" ? pointer.target_template_id
    : undefined;
  const variablesSrc = (typeof body.variables === "object" && body.variables !== null) ? body.variables
    : (typeof pointer.variables === "object" && pointer.variables !== null) ? pointer.variables
    : {};
  const variables = variablesSrc as Record<string, unknown>;
  const parentExecutionId = typeof body.parent_execution_id === "string" ? body.parent_execution_id
    : typeof pointer.parent_execution_id === "string" ? pointer.parent_execution_id
    : undefined;
  const compositionChain = Array.isArray(body.composition_chain) ? (body.composition_chain as string[])
    : Array.isArray(pointer.composition_chain) ? (pointer.composition_chain as string[])
    : [];

  if (!goal && !targetTemplateId) {
    return Response.json({ error: "goal or target_template_id is required" }, { status: 400 });
  }

  try {
    // Sync /resolve uses the SHARED runGoalWithRecovery (same loop as /run-goal, no
    // duplication). Bounded to maxAttempts 2 to stay under the MCP ~290s timeout;
    // the async /run-goal path recovers more deeply.
    const callerPinnedTarget = typeof targetTemplateId === "string" && targetTemplateId.length > 0;
    const seek = await runGoalWithRecovery(goal, {
      firstTarget: targetTemplateId,
      callerPinned: callerPinnedTarget,
      maxAttempts: 2,
      variables,
      parentExecutionId,
      compositionChain,
      surface: "/resolve",
    });

    return Response.json({
      resolved: true,
      shape: type === "goal_execution" ? "goalExecution" : "activityExecution",
      // Prefer the explicit routed executionId (feature_compose cutover sha) so a
      // routed edit via the sync /resolve path carries it too. Follow-up #1.
      executionId: seek.executionId ?? seek.result?.trace?.id,
      status: seek.status,
      selectedTemplateId: seek.selectedTemplateId,
      completionShapes: seek.completionShapes,
      attempts: seek.attempts,
      goalReachReason: seek.goalReachReason ?? null,
    });
  } catch (err) {
    console.error("[goal-host-vessel] /resolve error:", err);
    return Response.json(
      { resolved: false, shape: type, error: (err as Error).message },
      { status: 500 },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Async dispatch store — fire-and-forget execution with polling
//
// Bun's built-in fetch() has a 300s connection timeout that cannot be overridden
// via AbortSignal (Bun 1.3.14 caps it). Goals that take >5min cause boredom-vessel
// to see a connection failure even though goal-host-vessel is still executing.
//
// Solution: POST /run-goal returns 202+dispatchId immediately; the goal runs async;
// GET /executions/:dispatchId lets callers poll for completion. Boredom-vessel
// polls for up to ~270s then exits (systemd restarts it); the goal continues async.
// ─────────────────────────────────────────────────────────────────────────────

interface DispatchRecord {
  dispatchId: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  /** The dispatched goal text — surfaced so the operator feedback plane (provide_feedback) can auto-derive it. */
  goal?: string;
  executionId?: string;
  selectedTemplateId?: string;
  error?: string;
  /** State-space signature computed at dispatch time; threaded onto trace tags. */
  stateSignature?: StateSignatureBody;
  /**
   * Structured walk decision-log (reason plane, 2026-07-02): each entry is one
   * captured walk decision line (goal-target inference, derivation intent,
   * satisfier/bridge/step/reach). Populated from a caller-owned stepSink array
   * threaded into the goal-seek opts. Surfaced by GET /executions/:id and
   * rendered by the metabob-mcp goal_reasoning tool. Optional/additive — absent
   * on legacy records and on the synchronous /resolve path.
   */
  walkLog?: string[];
  /**
   * The honest goal-reach verdict (true=REACHED, false=HOLLOW/not-reached,
   * null=running/unknown) — distinct from `status`, which is only the template
   * exit status. A goal that REACHED via a direct vessel-resolve satisfier can
   * report `status:"failed"` yet `reached:true`; callers must trust `reached`,
   * not `status`, to decide whether to retry/escalate.
   */
  reached?: boolean | null;
  /**
   * The human-readable WHY behind the reach verdict (reason plane) — e.g. the
   * goal-reach judge's reason, or the feature_compose failure detail on routed
   * edit-intent dispatches. Optional/additive; absent on legacy records.
   */
  goalReachReason?: string;
  /**
   * The dispatch operator identity (attribution, #4) — echoed from the request
   * body and stamped into trace tags as `operator:<id>`. Absent when the caller
   * did not identify itself.
   */
  operator?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// computeStateSignature — fetch the substrate's current state-space
// signature from dev-vessel's compute_state_signature resolver. Threaded
// onto every dispatch's tags array so traces carry the environment they
// ran in. If the resolver fails or times out (10s AbortController), returns
// undefined and the caller proceeds without the tag.
// ─────────────────────────────────────────────────────────────────────────────
interface StateSignatureBody {
  signature_hash?: string;
  computed_at?: string;
  load?: Record<string, unknown>;
  recent_traces?: Record<string, unknown>;
  catalogue?: Record<string, unknown>;
}
async function computeStateSignature(
  loadedConceptIds?: string[],
): Promise<StateSignatureBody | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const pointer: Record<string, unknown> = { type: "compute_state_signature" };
    if (loadedConceptIds && loadedConceptIds.length > 0) {
      pointer.loaded_concept_ids = loadedConceptIds;
    }
    const resp = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}),
      },
      body: JSON.stringify({ impulse: { pointer } }),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) return undefined;
    const parsed = JSON.parse(text) as { success?: boolean; shape?: string; body?: StateSignatureBody };
    if (parsed?.success === true && parsed.body && typeof parsed.body === "object") {
      return parsed.body;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2.A.1 — Lazy state-signature cache (openspec 2026-06-03 pre-lift-bootstrap).
//
// computeStateSignature() above triggers a /proc-reading + recent-trace-aggregate
// + catalogue-count fetch on dev-vessel. Per the observation in
// validation/findings/goal-host-dispatch-setup-leak-2026-06-03/ this happens
// once per dispatch, and combined with the in-process state-signature compute
// inside dev-vessel, dominates the ~2 GB per-dispatch RSS delta.
//
// Cache the result with a TTL (default 60s). Invalidate on:
//   - WS event vessel.registered (proxy-registration triggers also fire)
//   - explicit invalidateSignatureCache() call (e.g. on environment-change
//     observability hooks we may add later)
//
// loaded_concept_ids vary per-dispatch; cache on the JSON-sorted form so two
// dispatches with the same loaded set share the cache, while different sets
// trigger a fresh compute. Cap variants at 8 to bound the cache.
// ─────────────────────────────────────────────────────────────────────────────
const SIGNATURE_CACHE_MS = parseInt(process.env["SIGNATURE_CACHE_MS"] ?? "60000", 10);
interface SignatureCacheEntry { computed_at: number; body: StateSignatureBody | undefined; }
const signatureCache = new Map<string, SignatureCacheEntry>();
const SIGNATURE_CACHE_MAX_KEYS = 8;
function invalidateSignatureCache(): void { signatureCache.clear(); }
function signatureCacheKey(loadedConceptIds?: string[]): string {
  if (!loadedConceptIds || loadedConceptIds.length === 0) return "_";
  return [...loadedConceptIds].sort().join(",");
}
async function getCachedStateSignature(
  loadedConceptIds?: string[],
): Promise<StateSignatureBody | undefined> {
  const key = signatureCacheKey(loadedConceptIds);
  const hit = signatureCache.get(key);
  if (hit && (Date.now() - hit.computed_at) < SIGNATURE_CACHE_MS) {
    return hit.body;
  }
  const body = await computeStateSignature(loadedConceptIds);
  // Evict oldest if at cap.
  if (signatureCache.size >= SIGNATURE_CACHE_MAX_KEYS && !signatureCache.has(key)) {
    const oldestKey = [...signatureCache.entries()]
      .sort((a, b) => a[1].computed_at - b[1].computed_at)[0]?.[0];
    if (oldestKey !== undefined) signatureCache.delete(oldestKey);
  }
  signatureCache.set(key, { computed_at: Date.now(), body });
  return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// emitAuthoringDecision — write a `substrateGap` impulse via dev-vessel so
// goal-host's auto-draft decisions become inspectable substrate state instead
// of console.log lines lost to journald. Categories:
//   - auto_draft_triggered           (top recommend score below threshold)
//   - auto_draft_reused              (LLM picked an existing gap-closing:auto-* template)
//   - auto_draft_authored            (drafter produced a new template; promoted)
//   - auto_draft_fallback_recommend  (no targetTemplateId AND no authored id; runGoal
//                                     falls through to /recommend selection)
// Wrapped in try/catch; 10s AbortController. Toggle via
// SUBSTRATE_AUTHORING_DECISION_EMIT=0 (default on).
async function emitAuthoringDecision(
  category: string,
  summary: string,
  classification_metadata: Record<string, unknown>,
): Promise<void> {
  if (process.env.SUBSTRATE_AUTHORING_DECISION_EMIT === "0") return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const gap = {
      id: `auto_draft_decision:${(classification_metadata.dispatchId as string | undefined) ?? crypto.randomUUID()}:${category}`,
      category,
      source: "goal_host_auto_draft",
      summary,
      detected_at: new Date().toISOString(),
      status: "open",
      classification_metadata,
    };
    const res = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}),
      },
      body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap } } }),
      signal: ctrl.signal,
    });
    try { await res.body?.cancel(); } catch { /* swallow */ }
  } catch (err) {
    console.warn(`[goal-host-vessel] emitAuthoringDecision(${category}) failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Cap store at 100 records to prevent unbounded growth across long uptime.
const executionStore = new Map<string, DispatchRecord>();
function pruneStore(): void {
  if (executionStore.size > 100) {
    const oldest = [...executionStore.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (const [id] of oldest.slice(0, 20)) executionStore.delete(id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "healthy",
        vesselId: VESSEL_ID,
        vesselName: "Goal Host Vessel",
        shapes: SHAPES,
        version: VERSION,
        llm: LLM_VESSEL_ENDPOINT ? `http-vessel:${LLM_VESSEL_ENDPOINT}` : "in-process",
      });
    }

    if (req.method === "POST" && url.pathname === "/run-goal") {
      return handleRunGoal(req);
    }

    if (req.method === "GET" && url.pathname.startsWith("/executions/")) {
      const dispatchId = url.pathname.slice("/executions/".length);
      const record = executionStore.get(dispatchId);
      if (!record) return Response.json({ error: "dispatch not found" }, { status: 404 });
      return Response.json({
        dispatchId: record.dispatchId,
        status: record.status,
        reached: record.reached ?? null,
        goalReachReason: record.goalReachReason ?? null,
        operator: record.operator ?? null,
        goal: record.goal,
        executionId: record.executionId,
        selectedTemplateId: record.selectedTemplateId,
        completionShapes: (record as { completionShapes?: string[] | null }).completionShapes ?? null,
        error: record.error,
        walkLog: record.walkLog,
      });
    }

    if (req.method === "POST" && url.pathname === "/resolve") {
      return handleResolve(req);
    }

    return new Response("Not Found", { status: 404 });
  },
  error(err) {
    console.error("[goal-host-vessel] unhandled error:", err);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(
  `[goal-host-vessel] started on port ${PORT}` +
  ` | activity-api: ${ACTIVITY_API_ENDPOINT}` +
  ` | producer-discovery: ${PRODUCER_DISCOVERY_ENDPOINT}` +
  ` | discovery: ${DISCOVERY_ENDPOINT}` +
  ` | llm: ${LLM_VESSEL_ENDPOINT ? `vessel(${LLM_VESSEL_ENDPOINT})` : "in-process"}`,
);

registerBuiltinResolvers();
await registerDevVesselProxies();
await registerDiscoveryProxies();
// Iteration 8 of the OOM hunt — WS subscriber ablation experiment.
//
// The leak signature from iter-5 (concept_s9ye5GKLw2L8): goal-host RSS grew
// 16.6 → 18.4 GB in 60s of IDLE time, boredom timer inactive, no inbound
// requests. The ONLY high-frequency idle-time actor not yet ablated is this
// WS subscriber, which receives EVERY broadcast from activity-api's `/ws`
// (task.*, lifecycle.*, vessel.* — from every vessel in the substrate) just
// to filter for `vessel.registered`. Even with the substring pre-parse guard
// (line 775), the raw frame allocation per message accumulates.
//
// Gated on env GOAL_HOST_WS_SUBSCRIBER (default "on"). Set to "off" to
// ablate. Verification path when substrate recovers:
//   - Restart goal-host with GOAL_HOST_WS_SUBSCRIBER=off
//   - Watch [gc-tick] for 5 min. If RSS stays bounded → WS is the source.
//   - If still grows → restore subscriber, escalate to iter 9.
//
// If WS is the source: the fix is NOT to permanently disable (we'd lose
// reactive dev-vessel re-registration after restarts). The fix is to either
// (a) switch to a topic-filtered subscription at activity-api side, or
// (b) replace the WS subscriber with a polling /shapes refresh every N
// seconds. Both are iter-9 work; this iteration only confirms the source.
const WS_SUBSCRIBER_ENABLED = (process.env.GOAL_HOST_WS_SUBSCRIBER ?? "on") !== "off";
if (WS_SUBSCRIBER_ENABLED) {
  // Reactive proxy registration: subscribe to vessel.registered events on the bus
  // so we re-fetch /shapes when dev-vessel (re)registers, regardless of whether
  // goal-host or dev-vessel booted first. Dissolves F-129.
  startVesselRegistrationSubscriber();
} else {
  console.log("[startup] WS subscriber DISABLED via GOAL_HOST_WS_SUBSCRIBER=off (iter-8 ablation)");
  // Fallback: poll dev-vessel /shapes every 60s to catch re-registrations.
  // Polling is bounded (one HTTP call per minute) so it can't accumulate.
  setInterval(() => {
    void registerDevVesselProxies();
  }, 60_000).unref();
}
await discoveryLoop.start();

// Graceful shutdown on SIGTERM.
process.on("SIGTERM", async () => {
  await discoveryLoop.stop();
  server.stop(true);
  console.log("[goal-host-vessel] stopped");
  process.exit(0);
});
