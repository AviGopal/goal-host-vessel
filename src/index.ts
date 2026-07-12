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
import { Config } from './config';
import { appendFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { inferGoalTargetShapes, inferGoalTargetDecision, inferDerivationSplit, goalHashOf, type GoalTargetDecision } from "./goal-target-inference";
import { routedComplete, routedText, flushRouterFeedback } from "./llm-router";
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

const BUS_MAX_INFLIGHT = Config.busMaxInflight;
const BUS_MAX_INFLIGHT_BYTES = Config.busMaxInflightBytes;
const BUS_QUEUE_MAX = Config.busQueueMax;
const BUS_STATS_INTERVAL_MS = Config.busStatsIntervalMs;
// When backpressure exceeds this window, fall through to drop+signal. Bounded
// to keep callers from hanging indefinitely if activity-api is wedged.
const BUS_BACKPRESSURE_MAX_WAIT_MS = Config.busBackpressureMaxWaitMs;
const DISPATCH_DROP_LOG_PATH = Config.dispatchDropLogPath;

// Env-defaulted endpoint for goal-host-vessel's own /run-goal route.
// Override with GOAL_HOST_VESSEL_ENDPOINT to avoid hardcoded host:port drift.
const GOAL_HOST_ENDPOINT = Config.goalHostEndpoint;
const FED_TRANSPORT_EGRESS = Config.fedTransportEgress;

/**
 * Resolve the HTTP endpoint to use for a discovered vessel record.
 * When discoveredVia === 'peer', the vessel lives on a remote substrate;
 * route through peerEndpoint (the peer discovery URL) so the request
 * reaches the correct substrate boundary. Also returns resolved_by_vessel_id
 * for provenance capture on execution traces.
 */
const asResolvePath = (rp: string | undefined): string => {
  if (!rp) return "/resolve";
  if (rp.startsWith("http://") || rp.startsWith("https://")) {
    try {
      const u = new URL(rp);
      return u.pathname + u.search;
    } catch {
      return "/resolve";
    }
  }
  return rp;
};

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
// Location-independent trace store (2026-07-05, gap trace-persistence-loss-2026-07-05):
// the store may live on this substrate or on a federation hub. Resolution order:
// explicit env override (ACTIVITY_API_ENDPOINT) → discovery lookup (who serves the
// trace shapes) → localhost default. Pattern follows super-repo 246e6491
// (discovery-routed store location for composition-edge-reconcile): fail-soft
// when discovery is dark, env always wins.
async function resolveTraceStoreEndpointViaDiscovery(): Promise<string | null> {
  const disc = process.env.DISCOVERY_VESSEL_ENDPOINT ?? "http://127.0.0.1:8100";
  const key = process.env.GOAL_HOST_VESSEL_API_KEY ?? process.env.METABOB_API_KEY ?? "";
  for (const shape of ["activityExecutionTrace_write", "executionTraceList", "activityExecutionTrace"]) {
    try {
      const r = await fetch(`${disc}/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `ApiKey ${key}` } : {}),
        },
        body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) continue;
      const j = await r.json() as { content?: { vessels?: Array<{ endpoint?: string }> } };
      const ep = j?.content?.vessels?.[0]?.endpoint;
      if (typeof ep === "string" && ep.length > 0) {
        const base = ep.replace(/\/v2\/impulses\/resolve\/?$/, "").replace(/\/$/, "");
        console.log(`[goal-host-vessel] trace store resolved via discovery (${shape}): ${base}`);
        return base;
      }
    } catch { /* try next shape — fail-soft */ }
  }
  console.log("[goal-host-vessel] trace store discovery dark — falling back to env/localhost default");
  return null;
}
const ACTIVITY_API_ENDPOINT = process.env.ACTIVITY_API_ENDPOINT
  ?? (await resolveTraceStoreEndpointViaDiscovery())
  ?? "http://127.0.0.1:8080";
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

const SHAPES = ["goal_execution", "activity_execution", "activeDispatches", "goalWalkState", "poolImpulse_write", "solicitationResponse_write", "solicitationHeartbeat_write", "goalDispatchAsync"] as const;
const VERSION = "0.1.0";
const DEV_VESSEL_ENDPOINT = process.env.DEVELOPMENT_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
const CONCEPT_DB_ENDPOINT = process.env.CONCEPT_DB_ENDPOINT ?? "http://127.0.0.1:8260";

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
  // ── Deterministic hollow pre-check (no LLM) ──────────────────────────────
  const dig = (contentDigest ?? "").trim();
  const meaningfulShapes = producedShapes.filter((s) => s !== "goal");

  if (dig === "" && meaningfulShapes.length === 0) {
    return { reached: false, reason: "deterministic:no-output — execution produced no content", completion_shapes: [] };
  }

  if (dig !== "") {
    // Error envelope check: reject ONLY when EVERY non-empty content line is an
    // error/failure line (the whole digest is an error), never on mere substring
    // containment — a legitimate reached output whose SUBJECT is failures (e.g. a
    // failure-mode report) contains these tokens and must fall through to the LLM.
    // Strip the "- <shape>: " digest-line prefix before matching.
    const lines = dig.split("\n").map((l) => l.replace(/^-\s+\S+:\s+/, "").trim()).filter((l) => l.length > 0);
    // A line is an error ONLY if it is a bare "error:" line, OR a JSON object/array
    // whose STRUCTURE is an error envelope (marker as a key) — never prose that merely
    // MENTIONS a failure token (e.g. "the execution failed_task_id t3 ..."), and never a
    // real count report like {"total":10,"failed":2}.
    const isErrorLine = (l: string) =>
      /^error:/i.test(l) ||
      (/^[\{\[]/.test(l) && (
        /"status"\s*:\s*"?failed/i.test(l) ||
        /"structuredError"/.test(l) ||
        /"failed_task_id"/.test(l) ||
        /^\{\s*"error"\s*:/.test(l)
      ));
    const allLinesAreError = lines.length > 0 && lines.every(isErrorLine);

    if (allLinesAreError) {
      return { reached: false, reason: "deterministic:error-envelope — output is an error/failure envelope", completion_shapes: [] };
    }

    // Placeholder check: strip leading "- <shape>: " digest prefix then check
    const digestBody = dig.replace(/^-\s+\S+:\s+/, "");
    if (/^\W*\{\{[^}]*\}\}\W*$/.test(digestBody)) {
      return { reached: false, reason: "deterministic:placeholder — output is an unfilled {{placeholder}}", completion_shapes: [] };
    }
    // Deterministic POSITIVE reach for the code-change family (no LLM): a FAVORABLE
    // featureComposeReport is ground truth — feature_compose only reaches FAVORABLE
    // after a typecheck-clean verify AND its semantic cutover gate (verifyPatchAddressesGap)
    // confirmed the drafted-from-goal diff addresses the intent, then applied/landed it.
    // Mirror of the negative checks above and of the edit-intent route which already
    // trusts FAVORABLE. Structure-anchored: report shape AND FAVORABLE verdict on the
    // SAME digest line (truncation of the verdict only degrades to the LLM, never a false positive).
    const favorableCompose = dig.split("\n").some((l) =>
      /featureComposeReport/.test(l) && /"verdict"\s*:\s*"?FAVORABLE/i.test(l)
    );
    if (favorableCompose) {
      return { reached: true, reason: "deterministic:favorable-compose — typecheck-clean change verified and applied by feature_compose", completion_shapes: ["featureComposeReport"] };
    }
  }
  // ── End deterministic pre-check — fall through to LLM ───────────────────

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
    // Routed per task type (reach_verification) across the llm-resolver fleet;
    // buffered under the goal hash and rewarded by this dispatch's final verdict.
    const rr = await routedComplete(goalHashOf(goal), "reach_verification", {
      prompt, model: "claude-haiku-4-5-20251001",
    });
    if (!rr.ok) return null;
    const j: any = rr.json;
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
const inferredTargetDecisionCache = new Map<string, GoalTargetDecision>();
function escalateNoProducerToInvestigation(goal: string, confidence: number | null): void { if (/^investigate and decompose/i.test(goal)) { return; } fetch("http://127.0.0.1:" + PORT + "/run-goal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal: "investigate and decompose goal: " + goal.slice(0, 400), tags: ["escalated_from:no_producer"] }) }).catch((e) => console.warn("[escalate-investigation] self-dispatch failed: " + (e as Error).message)); console.log("[goal-host-vessel] no-producer-across-alternatives (inference confidence=" + String(confidence) + ") - routed to investigate-and-decompose"); }

// ── UNIVERSAL TOOL-ENABLED FALLBACK (2026-07-11) ────────────────────────────
// When the structured shape-walk produces a HOLLOW result (an always-succeeds /
// generic producer was mis-picked, or a write's content was hallucinated), do the
// whole goal directly with a tool-enabled LLM carrying the full resolver toolkit —
// read tools plus the goal's own target write shapes — then re-verify. Robust reach
// floor for cold arbitrary goals. Additive, guarded, fail-open.
const UNIVERSAL_READ_TOOLS = [
  { name: "source_code", description: "Read a repo file's full source by repo-relative filePath. Read it yourself; never ask for it.", input_schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
  { name: "fs_read", description: "Read a file's contents by path.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "codeSearchResult", description: "Grep a single file for a regex pattern.", input_schema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"] } },
  { name: "shellResult", description: "Run a shell command to inspect the repo or system.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "substrateGap", description: "Query the substrate's gaps. Optional filters: category, status (open/closed), limit. Use this to read or aggregate substrate gaps.", input_schema: { type: "object", properties: { category: { type: "string" }, status: { type: "string" }, limit: { type: "number" } }, required: [] } },
];
async function ufResolveUrl(shape: string): Promise<string | null> {
  try {
    const r = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, { method: "POST", headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) }, body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }), signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json() as any; let vessels: any[] = Array.isArray(j?.content?.vessels) ? j.content.vessels : [];
    if (vessels.length === 0) {
      // Fallback: retry via the v2 impulses endpoint which some vessels register under
      try {
        const r2 = await fetch(`${DISCOVERY_ENDPOINT}/v2/impulses/resolve`, { method: "POST", headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) }, body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }), signal: AbortSignal.timeout(5000) });
        if (r2.ok) { const j2 = await r2.json() as any; vessels = Array.isArray(j2?.content?.vessels) ? j2.content.vessels : []; }
      } catch { /* fall through to return null */ }
      if (vessels.length === 0) return null;
    }
    // Mirror endpointForShape routeFor: prefer a plain-HTTP local row (protocol !== "libp2p"),
    // else fall back to a libp2p row (or PREFER_LIBP2P_ROUTE) via the local federation egress.
    const localHttp = vessels.find((x) => x && x.protocol !== "libp2p" && x.endpoint);
    if (localHttp) {
      const re = String(localHttp.resolve_endpoint ?? "/resolve");
      return (re.startsWith("http://") || re.startsWith("https://")) ? re : `${String(localHttp.endpoint).replace(/\/$/, "")}${re.startsWith("/") ? re : "/" + re}`;
    }
    const libp2p = vessels.find((x) => x && (x.protocol === "libp2p" || process.env.PREFER_LIBP2P_ROUTE === "1") && Array.isArray(x.libp2p_multiaddr) && x.libp2p_multiaddr[0]);
    if (libp2p) {
      const vid = libp2p.id ?? libp2p.vesselId;
      return FED_TRANSPORT_EGRESS + "/egress/resolve?target=" + encodeURIComponent(libp2p.libp2p_multiaddr[0]) + (vid ? "&vessel=" + encodeURIComponent(vid) : "");
    }
    return null;
  } catch { return null; }
}
async function ufBuildWriteTool(shape: string): Promise<any | null> {
  const url = await ufResolveUrl(shape); if (!url) return null;
  let envelope = ""; let fields: string[] = []; let required: string[] = [];
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) }, body: JSON.stringify({ impulse: { pointer: { type: "resolver_schema", shape } } }), signal: AbortSignal.timeout(4000) });
    if (r.ok) { const c = ((await r.json()) as any)?.content; if (c && c.known === true) { envelope = String(c.envelope ?? ""); fields = Array.isArray(c.fields) ? c.fields.map((f: any) => String(f.name)) : []; required = Array.isArray(c.required) ? c.required.map(String) : fields; } }
  } catch { /* fail-open: generic content field */ }
  const names = fields.length ? fields : ["content"];
  const req = required.length ? required : ["content"];
  const inner = { type: "object", properties: Object.fromEntries(names.map((f) => [f, { type: "string" }])), required: req };
  return { name: shape, description: `Perform the '${shape}' write/create action. ${envelope ? `Pass a single '${envelope}' object with fields ${names.join(", ")} (required: ${req.join(", ")}).` : `Fields: ${names.join(", ")}.`} Build the payload FAITHFULLY from the goal and what you read; never invent unrelated content.`, input_schema: envelope ? { type: "object", properties: { [envelope]: inner }, required: [envelope] } : inner };
}
async function universalToolFallback(goal: string, targetShapes: string[]): Promise<GoalSeekResult | null> {
  if (!LLM_VESSEL_ENDPOINT) return null;
  const url = await ufResolveUrl("llm_completion_dispatch"); if (!url) return null;
  const writeShapes = [...new Set(targetShapes)].filter((s) => /(_write|_create_write)$/.test(s));
  const tools: any[] = [...UNIVERSAL_READ_TOOLS];
  for (const ws of writeShapes) { const t = await ufBuildWriteTool(ws); if (t) tools.push(t); }
  const writeLine = writeShapes.length ? ` To PERFORM the required write/create/record action, call the matching write tool (${writeShapes.join(", ")}) with a payload built STRICTLY and FAITHFULLY from what the goal asks and what you read — never invent unrelated content.` : "";
  const prompt = `You are the substrate's universal executor. Accomplish this goal END-TO-END yourself using your available tools. You MUST gather the real data/content by CALLING your tools before you answer — never answer from memory or prior knowledge; an answer not grounded in what your tools actually returned is INVALID. Read source files with source_code/fs_read/codeSearchResult, run commands with shellResult, and query substrate data (e.g. gaps) with the matching read tool.${writeLine}\n\nGOAL: ${goal}\n\nWhen finished, respond with the final answer/result, grounded in your tool results.`;
  let text = ""; let toolCalls: any[] = [];
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) }, body: JSON.stringify({ impulse: { pointer: { type: "llm_completion_dispatch", prompt, max_tokens: 4096, tools } } }), signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
    if (!r.ok) return null;
    const j = await r.json() as any; text = j?.body?.text ?? j?.text ?? j?.content ?? ""; toolCalls = j?.body?.tool_calls ?? j?.tool_calls ?? [];
  } catch { return null; }
  if (!text || text.trim().length === 0) return null;
  const calledWrites = [...new Set(toolCalls.map((c: any) => c?.tool_name).filter((n: any) => typeof n === "string" && writeShapes.includes(n)))];
  const produced = [...new Set([...targetShapes, ...calledWrites])];
  if (produced.length === 0) produced.push("universal_fallback_result");
  const verdict = await verifyGoalReached(goal, produced, `universal tool fallback: ${toolCalls.length} tool call(s)`, text.slice(0, 6000));
  if (verdict?.reached) {
    console.log(`[goal-host-vessel] universal tool-enabled fallback REACHED goal after hollow structured walk (${toolCalls.length} tool calls)`);
    return { result: null, status: "completed", selectedTemplateId: "universal-tool-fallback", completionShapes: verdict.completion_shapes ?? produced, attempts: 1, goalReachReason: verdict.reason, reached: true, executionId: `universal-tool-fallback:${goalHashOf(goal)}` };
  }
  return null;
}

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
  if (shape.endsWith("_write") || shape.startsWith("obsidian:") || /^(fs_|code[A-Z]|file[A-Z])/.test(shape)) { console.log("[reach-gap] skip " + shape + ": parameter-rooted action shape, cold-unreachable by design"); return null; }
  let producerId = ""; let producerInputs: string[] = [];
  try { const pr = await fetch(`${PRODUCER_DISCOVERY_ENDPOINT}/v2/activities/discover-by-shapes`, { method: "POST", headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) }, body: JSON.stringify({ required_shapes: [shape], mode: "forward" }), signal: AbortSignal.timeout(8_000) }); if (pr.ok) { const pj = await pr.json() as { activities?: any[] }; if (!Array.isArray(pj?.activities) || pj.activities.length === 0) return null; const a0 = pj.activities[0] || {}; producerId = String(a0.variant_id || a0.id || ""); producerInputs = Array.isArray(a0.input_schema?.required_shapes) ? a0.input_schema.required_shapes.map(String) : []; } } catch { /* fail-open */ }
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
        classification_metadata: { kind: "reachability_gap", unreachable_shape: shape, unreachable_producer_id: producerId, producer_required_inputs: producerInputs, goal, goal_target_shapes: goalTargets, scope_narrowed: true },
      } } } }),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok ? id : null;
  } catch { return null; }
}

// MINT GOVERNOR (2026-07-04): throttle bridge-minting when the composition graph
// has no digestion headroom. Headroom is dev-vessel's learning_transfer_report
// genuine_edge_density.inequality_ok (the live lambda1 >= rho_grow signal),
// cached 5 minutes. Under NEGATIVE headroom a new auto-bridge may be minted ONLY
// when discovery confirms no live producer of the shape exists fleet-wide; when
// a producer exists the mint is refused with a cited reason and the walk's
// satisfier/candidate path handles the shape. Fail-open on any transport error.
let mintHeadroomCache: { ok: boolean; at: number } | null = null;
async function mintGovernorAllows(shape: string): Promise<boolean> {
  try {
    if (!mintHeadroomCache || Date.now() - mintHeadroomCache.at > 300_000) {
      const hr = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
        body: JSON.stringify({ impulse: { type: "learning_transfer_report" } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!hr.ok) return true;
      const hj = await hr.json() as { body?: { genuine_edge_density?: { inequality_ok?: boolean } } };
      const ok = hj?.body?.genuine_edge_density?.inequality_ok;
      if (typeof ok !== "boolean") return true;
      mintHeadroomCache = { ok, at: Date.now() };
    }
    if (mintHeadroomCache.ok) return true;
    const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!dr.ok) return true;
    const dj = await dr.json() as { content?: { vessels?: unknown[] } };
    const vessels = Array.isArray(dj?.content?.vessels) ? dj.content.vessels : [];
    if (vessels.length > 0) {
      console.log(`[mint-governor] refused: producer exists + headroom negative — shape="${shape}" served by ${vessels.length} vessel(s); routing stays on the existing producer`);
      return false;
    }
    console.log(`[mint-governor] allowed under negative headroom: no live producer of "${shape}" fleet-wide (true capability gap)`);
    return true;
  } catch (e) {
    console.warn(`[mint-governor] check failed (fail-open): ${(e as Error).message}`);
    return true;
  }
}
async function penaliseHollowTemplate(activityId: string, reason: string): Promise<{ templateId: string; dAlpha: number; dBeta: number }> {
  try {
    await fetch(`${ACTIVITY_API_ENDPOINT}/v2/activities/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({ activity_id: activityId, direction: "negative", intensity: 2, reason: `hollow completion (goal not reached): ${reason}`.slice(0, 200) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { /* non-fatal */ }
  // REACH-GATE FAILURE-CLASS CONCEPT (2026-07-04): mirror each hollow verdict to
  // concept-db at CLASS grain — stable content only (no goal text, execution ids,
  // or timestamps) so exact-content dedup holds: one concept per hollow class.
  // Fire-and-forget; concept-db down never blocks the penalty path.
  try {
    const m = /^deterministic:([a-z-]+)/.exec(reason ?? "");
    const cls = m ? `deterministic_${m[1]!.replace(/-/g, "_")}` : "llm_judged_hollow";
    const desc: Record<string, string> = {
      deterministic_no_output: "execution completed but produced no content-bearing output; prefer producers whose tasks emit real content",
      deterministic_error_envelope: "execution output was an error or failure envelope presented as a result; treat error envelopes as failures, not products",
      deterministic_placeholder: "execution output was an unfilled placeholder passed through as content; bind slots before emitting",
      llm_judged_hollow: "the reach judge found the produced output does not substantively fulfill the goal intent; hollow wrappers that only emit shape names get beta-penalised",
    };
    void fetch(`${CONCEPT_DB_ENDPOINT}/concepts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({
        source_type: "reach_gate_lesson",
        shape: "reach_gate_lesson",
        content: `reach-gate hollow class ${cls}: ${desc[cls] ?? "hollow completion of this class; prefer content-bearing goal-shaped producers"}`,
        summary: `reach-gate lesson: ${cls}`,
      }),
      signal: AbortSignal.timeout(10_000),
    }).then((r) => {
      console.log(`[reach-gate-lesson] class=${cls} mirrored to concept-db (http ${r.status})`);
    }).catch((err) => {
      console.warn(`[reach-gate-lesson] concept mirror failed: ${(err as Error).message}`);
    });
  } catch (e) {
    console.warn(`[reach-gate-lesson] classify failed (non-fatal): ${(e as Error).message}`);
  }
  // The feedback POST above is direction:"negative", intensity:2 — a β penalty on
  // the hollow template (no α change). Return the delta so terminalization can
  // surface it in DispatchRecord.learning (decision-transparency, 2026-07-07).
  return { templateId: activityId, dAlpha: 0, dBeta: 2 };
}
// Per-goal learning (2026-06-22). Record goal -> path -> reach into
// goal_execution_paths (keyed by goal_hash), so the SAME goal — whether from
// here (MCP) or the human-facing obsidian-vessel — accumulates per-goal Thompson
// α/β over subsequent attempts and the reaching path is attributable + reusable.
// path_activities is the attribution unit (the composition that ran). reached is
// the goal-reach verdict (NOT execution-status), so the per-goal posterior tracks
// genuine goal achievement, not hollow completion.
type WalkTier = "learned_pathway" | "satisfier" | "universal_tool_fallback" | "fresh_derivation";
async function recordGoalPath(goalText: string, pathActivities: string[], reached: boolean, durationMs: number, costUsd: number, walkTier: WalkTier = "fresh_derivation"): Promise<void> {
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
        inference_confidence: inferredTargetDecisionCache.get(goalHashOf(goalText))?.confidence ?? null,
        walk_tier: walkTier,
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
async function recommendExcluding(goalText: string, exclude: string[], repairSig?: string | null, targetShapes?: string[] | null): Promise<string | null> {
  if (!goalText) return null;
  try {
    const r = await fetch(`${ACTIVITY_API_ENDPOINT}/v2/activities/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({ task_description: goalText, goal: goalText, exclude_activities: exclude, limit: 6, min_success_rate: 0, ...(targetShapes && targetShapes.length ? { expected_output_shapes: targetShapes } : {}), ...(repairSig ? { repair_signature: repairSig } : {}), ...((await getCachedStateSignature())?.signature_hash ? { state_signature: (await getCachedStateSignature())?.signature_hash } : {}) }),
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
      const recShapes = (Array.isArray(x?.output_shapes) ? x.output_shapes : Array.isArray(x?.outputShapes) ? x.outputShapes : []) as string[];
      if (targetShapes && targetShapes.length && recShapes.length && !recShapes.some((s) => targetShapes.includes(String(s)))) continue;
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
  /**
   * Decision-ready markdown answer for an obsidian-surface question/request goal
   * (answer-delivery reach fix, 2026-07-07) — the human-consumable output the vault
   * renders. Set only when such a goal genuinely reached; absent otherwise.
   */
  answerBody?: string;
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
  // Selection-plane fields (decision-transparency, 2026-07-07): opportunistically
  // read from the discover/recommend row when present — omitted (not fabricated) when
  // the row does not carry them, so goalWalkState surfaces only genuine numbers.
  alpha?: number;
  beta?: number;
  sampledScore?: number;
  sampleCount?: number;
}

// Per-step decision record surfaced by goalWalkState.steps (decision-transparency,
// 2026-07-07) — the contract the obsidian dispatch panel renders. Each step is one
// walk selection: what was picked, from which candidates, what was excluded, what
// new shapes it produced, and the pool before/after. `shadow:true` marks secondary
// dispatches (recovery retries, satisfier probes, losing horizontal siblings).
interface WalkStepCandidate {
  templateId: string;
  alpha?: number;
  beta?: number;
  sampledScore?: number;
  rejectedBecause?: string;
}
interface WalkStep {
  index: number;
  at: number;
  selected: {
    templateId: string;
    source: "thompson" | "satisfier" | "bridge" | "recovery" | "improvise";
    sampledScore?: number;
    alpha?: number;
    beta?: number;
  };
  candidates: WalkStepCandidate[];
  excluded: Array<{ templateId: string; reason: string }>;
  status: string;
  newShapes: string[];
  rationale?: string;
  poolBefore: string[];
  poolAfter: string[];
  shadow?: boolean;
}

// Learning consequences accumulated at terminalization (decision-transparency,
// 2026-07-07). Populated ONLY from paths that actually run at terminalization: the
// hollow β-penalty (penaliseHollowTemplate), capability/reachability gap filing, and
// the per-goal path record (recordGoalPath). goal-host writes no oracle label at
// terminalization, so oracleLabelWritten stays false here (that is the operator
// provide_feedback plane).
interface LearningConsequences {
  alphaBetaDelta: Array<{ templateId: string; dAlpha: number; dBeta: number }>;
  gapsFiled: string[];
  goalPathRecorded: boolean;
  oracleLabelWritten: boolean;
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
  const numOr = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const alpha = numOr(x.alpha ?? x.thompson_alpha ?? x.metrics?.thompson_alpha);
  const beta = numOr(x.beta ?? x.thompson_beta ?? x.metrics?.thompson_beta);
  const sampledScore = numOr(x.sampled_score ?? x.sampledScore ?? x.thompson_score ?? x.score ?? x.composition_score);
  const sampleCount = numOr(x.sample_count ?? x.sampleCount ?? x.metrics?.sample_count);
  return {
    id, inputShapes, outputShapes,
    ...(alpha !== undefined ? { alpha } : {}),
    ...(beta !== undefined ? { beta } : {}),
    ...(sampledScore !== undefined ? { sampledScore } : {}),
    ...(sampleCount !== undefined ? { sampleCount } : {}),
  };
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
    /** Learning plane: caller-owned accumulator; terminalization consequences pushed here (decision-transparency). */
    learningSink?: LearningConsequences;
    /** Shapes for which the vessel-resolve satisfier must be SKIPPED this walk (pre-seeds satisfierTried) — set on hollow-satisfier retry so the walk falls through to the candidate / bridge-mint route. */
    suppressSatisfierShapes?: string[];
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
    const widEv = opts.variables.dispatch_id;
    if (typeof widEv === "string") {
      const recEv = executionStore.get(widEv);
      if (recEv) {
        recEv.poolEvents = [...(recEv.poolEvents ?? []), { shape, source: summary ?? `pool impulse (${shape})`, at: Date.now() }].slice(-64);
      }
    }
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
  let walkTerminationReason: string | undefined;
  for (const s of opts.suppressSatisfierShapes ?? []) satisfierTried.add(s);

  const llmExtractPointerArgs = async (shape: string, correction?: string): Promise<Record<string, unknown> | null> => {
    if (!LLM_VESSEL_ENDPOINT) return null;
    let schemaContract = "";
   try {
     const sep = await endpointForShape(shape);
     if (sep) {
       const sr = await fetch(`${sep.endpoint}${sep.resolvePath}`, {
         method: "POST",
         headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
         body: JSON.stringify({ impulse: { pointer: { type: "resolver_schema", shape } } }),
         signal: AbortSignal.timeout(4000),
       });
       if (sr.ok) {
         const sj = await sr.json() as { content?: any };
         const cc = sj?.content;
         if (cc && cc.known === true && Array.isArray(cc.fields)) {
           const req = cc.fields.filter((f: any) => f.required).map((f: any) => f.name);
           const opt = cc.fields.filter((f: any) => !f.required).map((f: any) => f.name);
           schemaContract = `AUTHORITATIVE PAYLOAD CONTRACT for shape "${shape}" (from the owning vessel — this is the exact structure to emit, prefer it over any prose guidance): put the pointer args UNDER the key "${cc.envelope}" as a nested object. REQUIRED fields, all must be present with real values from the goal: ${req.join(", ") || "(none)"}. Optional fields: ${opt.join(", ") || "(none)"}. Your JSON output must have the form { "${cc.envelope}": { ${req.map((r: string) => `"${r}": <value>`).join(", ")} } } (add optional fields when the goal specifies them).\n\n`;
         }
       }
     }
   } catch { /* fail-open: no vessel schema advertised, fall back to how-to + goal text */ }
   let howToGuidance = "";
    try {
      const hq = encodeURIComponent(`${shape} pointer arguments payload fields how to invoke resolver`);
      const hr = await fetch(`${CONCEPT_DB_ENDPOINT}/concepts/search?query=${hq}&limit=3`, { headers: API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}, signal: AbortSignal.timeout(4000) });
      if (hr.ok) {
        const hj = await hr.json() as { concepts?: Array<{ summary?: string; content?: string }> };
        const lines = (hj.concepts ?? []).map((k) => `- ${String(k.summary ?? "").slice(0, 120)}: ${String(k.content ?? "").slice(0, 400)}`).filter((s) => s.length > 8);
        if (lines.length) howToGuidance = `PAYLOAD GUIDANCE for shape "${shape}" from the substrate's knowledge store — the correct pointer-arg field structure to emit (follow it EXACTLY, including any nested objects it names):\n${lines.join("\n")}\n\n`;
      }
    } catch { /* fail-open: no how-to available, fall back to goal-text-only extraction */ }
    const nowIso = new Date().toISOString();
    const temporalGrounding = `CURRENT DATE/TIME (authoritative, from the substrate host clock): ${nowIso} (today's date: ${nowIso.slice(0, 10)}). Any relative temporal reference in the goal — "today", "tonight", "yesterday", "this week", a daily-note date, a dated filename — MUST be computed from this value. NEVER guess or invent a date.\n\n`;
    const prompt = `${temporalGrounding}${schemaContract}${howToGuidance}A resolver for the impulse shape "${shape}" must be invoked to satisfy this goal. Extract ONLY the pointer argument fields that the resolver needs, from the goal text. For a write/note shape that means fields like "path" and "content"; for a read shape a "path" or "query"; emit only fields the goal actually specifies or clearly implies.

GOAL: ${goal}

Respond with ONLY a JSON object of the pointer arg fields the resolver needs. If PAYLOAD GUIDANCE is present above, follow its field structure exactly (including any nested objects it specifies); otherwise emit a flat object. Do NOT add a top-level "type" key or wrap the result in a "pointer" key.${correction ? `\nA PREVIOUS ATTEMPT WAS REJECTED BY THE RESOLVER WITH: ${correction}\nEmit corrected args including the required fields (sensible values from the goal, or defaults like limit=10, since_hours=24).` : ""}`;
    try {
      const rr = await routedComplete(goalHashOf(goal), "pointer_arg_extraction", {
        prompt, model: "claude-haiku-4-5-20251001",
      });
      if (!rr.ok) return null;
      const j: any = rr.json;
      const text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
      const m = String(text).match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]);
      const args = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : null;
      if (!args) return null;
      // DATE-ARG NORMALISATION (2026-07-11): relative temporal references must bind
      // to the substrate's real clock, never the LLM's guess. When the goal implies
      // the current day ("today", "tonight", "daily note") and names no explicit
      // date itself, force any YYYY-MM-DD substring in string args — and any "date"
      // arg — to the actual current date.
      const todayStr = new Date().toISOString().slice(0, 10);
      const goalImpliesToday = /\btoday\b|\btonight\b|\bdaily[- _]?note\b/i.test(goal) && !/\b\d{4}-\d{2}-\d{2}\b/.test(goal);
      if (goalImpliesToday) {
        for (const k of Object.keys(args)) {
          const v = args[k];
          if (typeof v === "string" && /\d{4}-\d{2}-\d{2}/.test(v)) args[k] = v.replace(/\d{4}-\d{2}-\d{2}/g, todayStr);
        }
        if ("date" in args && typeof args["date"] === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(args["date"] as string)) args["date"] = todayStr;
      }
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
    } catch (e) { lastRawResolveReason = String((e as Error)?.message ?? "fetch failed").slice(0, 200); console.log(`[goal-host-vessel] walk rawResolve ${shape}: fetch threw ${String((e as Error)?.message ?? "").slice(0, 140)}`); return null; }
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
        if (v.protocol === "libp2p" && Array.isArray(v.libp2p_multiaddr) && v.libp2p_multiaddr[0]) {
          // libp2p-reachable peer: route the resolve through the local federation-transport
          // egress (goal-host has no libp2p deps), passing the peer multiaddr as ?target=.
          return { endpoint: FED_TRANSPORT_EGRESS, resolvePath: `/egress/resolve?target=${encodeURIComponent(v.libp2p_multiaddr[0])}${v.id ? `&vessel=${encodeURIComponent(v.id)}` : ""}`, resolvedByVesselId: v.id };
        }
        if (process.env.PREFER_LIBP2P_ROUTE === "1" && Array.isArray(v.libp2p_multiaddr) && v.libp2p_multiaddr[0]) {
          // Operator-flagged location transparency: prefer the libp2p egress route for ANY
          // candidate advertising a multiaddr, regardless of discoveredVia. Flag OFF = no change.
          return { endpoint: FED_TRANSPORT_EGRESS, resolvePath: "/egress/resolve?target=" + encodeURIComponent(v.libp2p_multiaddr[0]) + (v.id ? "&vessel=" + encodeURIComponent(v.id) : ""), resolvedByVesselId: v.id };
        }
        // Cross-substrate: when discovery returns a peer-advertised vessel, prefer
        // routing the resolve through the peer's gateway endpoint and tag the
        // peer vessel id as resolved_by_vessel_id for execution-trace provenance.
        if (v.discoveredVia === "peer" && v.peerEndpoint) {
          return { endpoint: v.peerEndpoint.replace(/\/+$/, ""), resolvePath: asResolvePath(v.resolve_endpoint), resolvedByVesselId: v.id };
        }
        const resolvePath = asResolvePath(typeof v.resolve_endpoint === "string" ? v.resolve_endpoint : undefined);
        return { endpoint: (v.endpoint ?? "").replace(/\/+$/, ""), resolvePath };
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
  let lastRawResolveReason: string | null = null;
  async function verifyWritePersisted(
    writeShape: string,
    writeResult: unknown,
  ): Promise<{ persisted: true; content: unknown } | { persisted: false } | null> {
    const isPersistingWrite = /_write$/.test(writeShape) || writeShape === "write_note";
    if (!isPersistingWrite) return null;

    try {
      // Parse id from writeResult
      let id: string | undefined;
      const tryParseId = (v: unknown): string | undefined => {
        if (typeof v === "object" && v !== null) {
          const obj = v as Record<string, unknown>;
          if (typeof obj["id"] === "string") return obj["id"];
          if (typeof obj["content"] === "string") {
            try {
              const inner = JSON.parse(obj["content"]) as Record<string, unknown>;
              if (typeof inner["id"] === "string") return inner["id"];
            } catch { /* ignore */ }
          }
        }
        return undefined;
      };
      if (typeof writeResult === "string") {
        try { id = tryParseId(JSON.parse(writeResult)); } catch { /* ignore */ }
      } else {
        id = tryParseId(writeResult);
      }
      if (!id) return { persisted: false };

      // Derive read shape: strip trailing _write, then leading verb segment
      let readShape = writeShape.replace(/_write$/, "");
      // e.g. concept_create -> concept; note_create -> note
      readShape = readShape.replace(/^[a-z]+_create$/, (m) => m.replace(/_create$/, ""));
      // fallback: strip any remaining _<verb> suffix
      readShape = readShape.replace(/_[a-z]+$/, "") || readShape;

      const ep = await endpointForShape(readShape);
      if (!ep) return { persisted: false };
      const readResult = await rawResolve(readShape, ep.endpoint, ep.resolvePath, { id });
      if (readResult != null) {
        const asObj = typeof readResult === "object" && readResult !== null
          ? readResult as Record<string, unknown>
          : null;
        const hasId =
          asObj &&
          (asObj["id"] === id ||
            (typeof asObj["content"] === "string" && asObj["content"].includes(id)));
        if (hasId) return { persisted: true, content: readResult };

        // concept-db REST fallback
        try {
          const fbResp = await fetch(`${ep.endpoint}/concepts/${id}`, {
            signal: AbortSignal.timeout(8_000),
          });
          if (fbResp.ok) {
            const fbBody = await fbResp.json() as unknown;
            return { persisted: true, content: fbBody };
          }
        } catch { /* fail-open */ }
      }
      return { persisted: false };
    } catch {
      // fail-open: infrastructure error must not block the walk
      return null;
    }
  }
  const rawResolve = async (shape: string, endpoint: string, resolvePath: string, extraArgs: Record<string, unknown>): Promise<unknown | null> => {
    lastRawResolveReason = null;
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
    } catch (e) {
      lastRawResolveReason = `transport: ${String((e as Error).message ?? e).slice(0, 180)}`;
      console.log(`[goal-host-vessel] walk rawResolve ${shape}: transport error — ${String((e as Error).message ?? e).slice(0, 140)}`);
      return null;
    }
    const bodyText = await resp.text();
    if (!resp.ok) { lastRawResolveReason = bodyText.slice(0, 200); console.log(`[goal-host-vessel] walk rawResolve ${shape}: HTTP ${resp.status} ${bodyText.slice(0, 140)}`); return null; }
    let parsed: unknown;
    try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
    let content: unknown = parsed;
    const pObj = (typeof parsed === "object" && parsed !== null) ? parsed as Record<string, unknown> : null;
    if (pObj) {
      if (pObj["success"] === false) { lastRawResolveReason = String(pObj["error"] ?? "").slice(0, 200); console.log(`[goal-host-vessel] walk rawResolve ${shape}: success=false ${String(pObj["error"] ?? "").slice(0, 140)}`); return null; }
      // A resolver that rejected the pointer returns { error: "..." } (e.g.
      // analysis-vessel's "filePaths is required") with no content/body. That is a
      // FAILURE, not produced content — without this the walk would "produce" the
      // shape with an error object as its content and fool the reach-gate. Return
      // null so the satisfier falls through to the unchanged bridge/escalate path.
      if (typeof pObj["error"] === "string" && pObj["error"].length > 0 && !("content" in pObj) && !("body" in pObj)) {
        lastRawResolveReason = pObj["error"].slice(0, 200);
        console.log(`[goal-host-vessel] walk rawResolve ${shape}: resolver rejected — ${pObj["error"].slice(0, 140)}`);
        return null;
      }
      if ("content" in pObj) content = pObj["content"];
      else if ("body" in pObj) content = pObj["body"];
    }
    if (content == null || (typeof content === "string" && content.trim().length === 0) || (Array.isArray(content) && content.length === 0)) {
      lastRawResolveReason = "resolver returned empty content";
      console.log(`[goal-host-vessel] walk rawResolve ${shape}: empty content (HTTP ${resp.status})`);
      return null;
    }
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
    const nowIso = new Date().toISOString();
    const temporalGrounding = `CURRENT DATE/TIME (authoritative, from the substrate host clock): ${nowIso} (today's date: ${nowIso.slice(0, 10)}). Any relative temporal reference in the goal — "today", "tonight", "yesterday", "this week", a daily-note date, a dated filename — MUST be computed from this value. NEVER guess or invent a date.\n\n`;
    const prompt = `${temporalGrounding}The goal needs the impulse shape "${target}" to exist, but resolving it directly returned nothing (it does not exist yet). The vessel that owns "${target}" also offers these resolver shapes that may PRODUCE/CREATE it: ${JSON.stringify(siblings)}.${constraintBlock}

GOAL: ${goal}${correctionBlock}

If one of those sibling shapes is the action that would create what the goal asks for (e.g. a write/create action), respond with ONLY JSON {"shape": "<sibling shape>", "args": { ...flat pointer arg fields extracted from the goal, e.g. path/content }}. If none of them is an appropriate creating action for this goal, respond with {"shape": null}.`;
    try {
      const rr = await routedComplete(goalHashOf(goal), "action_shape_selection", {
        prompt, model: "claude-haiku-4-5-20251001",
      });
      if (!rr.ok) return null;
      const j: any = rr.json;
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
    // PROCESS STEP: transform the raw intermediate findings into the FINAL artifact
    // the goal asks to persist (e.g. a how-to, note, summary), rather than dumping raw
    // source-code / investigation material. Fail-open: on any error, keep raw.
    const processTerminalContent = async (targetShape: string, raw: string): Promise<string> => {
      if (!raw) return raw;
      if (!LLM_VESSEL_ENDPOINT) return raw;
      try {
        const prompt = `You are producing the FINAL artifact to store for a goal, from raw material an earlier step produced. Do NOT dump the raw material; TRANSFORM it into exactly what the goal asks to persist — structured, concise, and usable (e.g. a how-to, a note, a summary, a structured record), in the form the goal specifies. \n\nGOAL: ${goal}\n\nTARGET ARTIFACT SHAPE: ${targetShape}\n\nRAW MATERIAL (from investigation/intermediate steps):\n${raw.slice(0, 8000)}\n\nRespond with ONLY the final artifact content to store (plain text; no preamble, no code fences).`;
        const rr = await routedComplete(goalHashOf(goal), "terminal_content_process", {
          prompt, model: "claude-haiku-4-5-20251001",
        });
        if (!rr.ok) return raw;
        const j: any = rr.json;
        const text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
        const s = String(text || "").trim();
        return s ? s : raw;
      } catch { return raw; }
    };
    const processedBody = boundBody ? await processTerminalContent(shape, boundBody) : boundBody;
    let writeEnvelope: { envelope: string; required: string[] } | null = null;
    try {
      const sep0 = await endpointForShape(shape);
      if (sep0) {
        const sr0 = await fetch(`${sep0.endpoint}${sep0.resolvePath}`, { method: "POST", headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) }, body: JSON.stringify({ impulse: { pointer: { type: "resolver_schema", shape } } }), signal: AbortSignal.timeout(4000) });
        if (sr0.ok) { const sj0 = await sr0.json() as { content?: any }; const cc0 = sj0?.content; if (cc0 && cc0.known === true && typeof cc0.envelope === "string" && cc0.envelope) writeEnvelope = { envelope: cc0.envelope, required: Array.isArray(cc0.required) ? cc0.required : [] }; }
      }
    } catch { /* fail-open: no envelope contract advertised */ }
    const bindBody = (args: Record<string, unknown>): Record<string, unknown> => {
      if (writeEnvelope) {
        const inner: Record<string, unknown> = { ...args };
        if (processedBody) inner["content"] = processedBody;
        if (writeEnvelope.required.includes("source_type") && !("source_type" in inner)) inner["source_type"] = "memo";
        return { [writeEnvelope.envelope]: inner };
      }
      if (!processedBody) return args;
      const out = { ...args };
      for (const k of ["content", "body", "text", "note", "markdown"]) if (k in out) out[k] = processedBody;
      if (!("content" in out)) out["content"] = processedBody;
      return out;
    };
    // (a) Try resolving the target shape directly with goal-extracted args.
    const directArgsRaw = (await llmExtractPointerArgs(shape)) ?? {};
    const directArgs = bindBody(directArgsRaw);
    if (boundBody) console.log(`[goal-host-vessel] walk(${opts.surface}): bound terminal "${shape}" content: processed ${boundBody?.length ?? 0} raw chars -> ${processedBody?.length ?? 0} artifact chars`);
    const direct = await rawResolve(shape, ep.endpoint, ep.resolvePath, directArgs);
    if (direct != null) {
      const v = await verifyWritePersisted(shape, direct);
      if (v !== null && "persisted" in v && v.persisted === true) {
        return { content: v.content };
      } else if (v !== null && "persisted" in v && v.persisted === false) {
        tap(`[goal-host-vessel] walk: write "${shape}" claimed success but effect NOT independently readable — treating as non-persistence`);
        // fall through to action-then-read / bridge / escalate
      } else {
        return { content: direct };
      }
    }
    if (lastRawResolveReason) {
      const correctedRaw = await llmExtractPointerArgs(shape, lastRawResolveReason);
      if (correctedRaw) {
        const corrected = await rawResolve(shape, ep.endpoint, ep.resolvePath, bindBody({ ...directArgsRaw, ...correctedRaw }));
        if (corrected != null) { console.log(`[goal-host-vessel] walk(${opts.surface}): satisfier "${shape}" succeeded after arg-correction`); return { content: corrected }; }
      }
    }
    // (a.5) INVESTIGATION FALLBACK: deterministic resolver failed because a required
    //       argument (e.g. filePath) cannot be bound from the goal text — the goal
    //       names a vessel/contract, not a file. Let a tool-enabled LLM investigate
    //       and produce the content itself before falling through to a hollow bridge.
    if (LLM_VESSEL_ENDPOINT && !terminalShapes.has(shape) && !shape.endsWith("_write") && lastRawResolveReason && /required|missing|must (be|provide|include)|is not (a )?(valid|provided)|no .*(path|file|arg)/i.test(lastRawResolveReason)) {
      try {
        const invEp = await endpointForShape("llm_completion_dispatch");
        if (invEp) {
          const invPrompt = `You are investigating to produce the content for the impulse shape "${shape}" that the following goal needs. The deterministic resolver for this shape could not run because a required argument is missing: ${lastRawResolveReason}. You MUST use your tools (source_code, fs_read, codeSearchResult, shellResult) to FIND and READ the relevant source/files yourself — do not ask for them.\n\nGoal:\n${goal}\n\nRespond with ONLY the concrete content (file contents, analysis, or answer) — no preamble, no code fences.`;
          const ir = await fetch(`${invEp.endpoint}${invEp.resolvePath}`, { method: "POST", headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) }, body: JSON.stringify({ impulse: { pointer: { type: "llm_completion_dispatch", prompt: invPrompt, max_tokens: 4096 } } }), signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
          if (ir.ok) {
            const ij: any = await ir.json();
            const itext: string = ij?.body?.text ?? ij?.text ?? ij?.content ?? "";
            if (typeof itext === "string" && itext.length > 0) {
              tap(`[goal-host-vessel] walk: satisfier produced "${shape}" via tool-enabled LLM investigation (reason: ${lastRawResolveReason})`);
              return { content: itext };
            }
          }
        }
      } catch { /* fail-open: fall through to action-then-read / bridge */ }
    }
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

    // ── Hydrate walk pool from substrate standing pool (2026-07-03) ──────────
    // Fetch open poolImpulse records from development-vessel via discovery-based
    // resolve. Enriches the walk with standing context but is NEVER fatal.
    try {
      const _standingResp = await Promise.race([
        (async () => {
          // Resolve development-vessel endpoint for poolImpulse shape
          let devVesselResolveUrl = `${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`;
          try {
            const _dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
              body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "poolImpulse" } }),
              signal: AbortSignal.timeout(2_000),
            });
            const _dj = await _dr.json() as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string }> } };
            const _v = _dj?.content?.vessels?.[0];
            if (_v?.endpoint) {
              devVesselResolveUrl = `${_v.endpoint.replace(/\/+$/, "")}${asResolvePath(_v.resolve_endpoint)}`;
            }
          } catch { /* discovery unreachable → env fallback carries */ }
          const _r = await fetch(devVesselResolveUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
            body: JSON.stringify({ pointer: { type: "poolImpulse", status: "open", limit: 20 } }),
            signal: AbortSignal.timeout(2_000),
          });
          return _r;
        })(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("standing-pool timeout")), 3_000)),
      ]);
      if (_standingResp.ok) {
        const _sj = await _standingResp.json() as { impulses?: Array<{ shape: string; body: Record<string, unknown> }> };
        const _impulses = _sj?.impulses ?? [];
        for (const impulse of _impulses) {
          if (impulse.shape && impulse.body) {
            addToPool(impulse.shape, impulse.body);
          }
        }
      }
    } catch {
      tap("[walk-pool] standing pool hydrate skipped");
    }
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
  // ANSWER-DELIVERY REACH FIX (decision-transparency, 2026-07-07): snapshot the
  // pool shapes present BEFORE any walk step ran. A reach judged solely on these
  // pre-existing seed shapes (e.g. active_note_path, open_note_paths) delivered no
  // NEW answer to the human — the reach gate below rejects seed-only completion for
  // obsidian-surface question/request goals and requires a produced answerBody.
  const seedShapes = new Set<string>(producedShapes);
  const isObsidianSurface = typeof opts.variables.obsidian_vessel_endpoint === "string"
    && (opts.variables.obsidian_vessel_endpoint as string).length > 0;
  const isQuestionGoal = /\?\s*$/.test(goal)
    || /^\s*(what|who|whom|whose|when|where|why|how|which|is|are|am|do|does|did|can|could|should|would|will|list|show|tell|explain|describe|summar|report|give|find)\b/i.test(goal);
  const isObsidianQuestion = isObsidianSurface && isQuestionGoal;
  // With an explicit target, "met" = all target shapes produced. With NO target,
  // never short-circuit here — walk opportunistically (progress-driven), stopping
  // on MAX_STEPS or the consecutive-no-progress break below.
  const targetMet = (): boolean => target.size > 0 && [...target].every((s) => producedShapes.has(s));

  const chain: string[] = [];          // selected activity ids = the composition
  const chainExecIds: string[] = [...(opts.compositionChain ?? [])]; // recorded composition chain (execution ids)
  const exclude = new Set<string>();   // normalised activity ids already used / rejected
  let lastTrace: ExecutionTrace | null = null;
  let lastExecId: string | undefined = opts.parentExecutionId;
  const satisfierTraces: ExecutionTrace[] = [];
  let lastPick = "";
  let totalDurationMs = 0;
  let totalCostUsd = 0;
  let consecutiveNoProgress = 0;
  let earlyReachVerdict: GoalReachVerdict | null = null;
  let satisfierSeq = 0; // synthetic-trace id counter for vessel-resolve satisfier steps
  // Per-step decision tree (decision-transparency, 2026-07-07): each walk selection
  // pushes a WalkStep here; mirrorWalkState mirrors it onto rec.steps every iteration
  // so goalWalkState surfaces the structured tree WHILE the walk runs.
  const walkSteps: WalkStep[] = [];
  let walkStepIndex = 0;

  // ── 2-3. Walk the shape graph ──────────────────────────────────────────────
  // Live walk-state mirror (goalWalkState read shape): snapshot the pool +
  // pending targets onto the dispatch record each iteration so POST /resolve
  // can surface a running walk's state. Additive — never alters control flow.
  const mirrorWalkState = (): void => {
    const wid = opts.variables.dispatch_id;
    if (typeof wid !== "string") return;
    const rec = executionStore.get(wid);
    if (!rec) return;
    rec.poolShapes = [...producedShapes];
    rec.pendingTargets = [...target].filter((s) => !producedShapes.has(s));
    // Live "why" (2026-07-06): mirror the accumulating walk decision trail onto
    // the record EACH iteration so goalWalkState surfaces WHY the walk is doing
    // what it's doing WHILE it runs. Previously rec.walkLog was assigned once, at
    // terminalization, leaving currentStep null for the entire live duration.
    // Bounded tail keeps the snapshot small; the full log still lands at the end.
    if (opts.stepSink && opts.stepSink.length > 0) rec.walkLog = opts.stepSink.slice(-60);
    // Structured per-step decision tree (decision-transparency, 2026-07-07). Same
    // array reference throughout, so pushes after the first mirror are reflected live.
    (rec as { steps?: WalkStep[] }).steps = walkSteps;
  };
  const shapeArr = (): string[] => [...producedShapes];
  const excludedNow = (): Array<{ templateId: string; reason: string }> =>
    [...exclude].map((id) => ({ templateId: id, reason: "already used or rejected earlier in walk" }));
  const recordStep = (step: Omit<WalkStep, "index" | "at">): void => {
    walkSteps.push({ index: walkStepIndex++, at: Date.now(), ...step });
    mirrorWalkState();
  };
  // Drain human-injected impulses (poolImpulse_write) into the pool. Pushes
  // directly (not via addToPool) so an injected impulse is added even when its
  // shape is already present in the pool.
  const drainInjectedImpulses = (): void => {
    const wid = opts.variables.dispatch_id;
    if (typeof wid !== "string") return;
    const queued = injectedPoolImpulses.get(wid);
    if (!queued || queued.length === 0) return;
    injectedPoolImpulses.delete(wid);
    for (const inj of queued) {
      producedShapes.add(inj.shape);
      poolImpulses.push(mkImpulse(inj.shape, inj.content, inj.summary ?? `human-contributed impulse (${inj.shape})`));
      tap(`[goal-host-vessel] walk(${opts.surface}): human-injected impulse added to pool shape=${inj.shape}`);
    }
  };
  while (chain.length < MAX_STEPS && !targetMet()) {
    drainInjectedImpulses();
    mirrorWalkState();
    const iterPoolBefore = [...producedShapes];
    let pickSource: WalkStep["selected"]["source"] = "thompson";
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
          satisfierTraces.push(synthTrace);
          chain.push(satId);
          exclude.add(normActivityId(satId));
          chainExecIds.push(synthTrace.id);
          lastTrace = synthTrace;
          lastExecId = synthTrace.id;
          lastPick = satId;
          recordStep({
            selected: { templateId: satId, source: "satisfier" },
            candidates: [],
            excluded: excludedNow(),
            status: "completed",
            newShapes: [satisfiableNow],
            rationale: `vessel-resolve satisfier produced "${satisfiableNow}" via a connected vessel (no bridge/template needed)`,
            poolBefore: iterPoolBefore,
            poolAfter: shapeArr(),
          });
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
        const bundleNew = [...producedShapes].filter((s) => !iterPoolBefore.includes(s));
        for (let bi = 0; bi < bundle.length; bi++) {
          const bc = bundle[bi];
          const bt = branchResults[bi];
          const isWinner = bestPickId === bc.id;
          recordStep({
            selected: {
              templateId: bc.id, source: "thompson",
              ...(bc.sampledScore !== undefined ? { sampledScore: bc.sampledScore } : {}),
              ...(bc.alpha !== undefined ? { alpha: bc.alpha } : {}),
              ...(bc.beta !== undefined ? { beta: bc.beta } : {}),
            },
            candidates: bundle.map((c) => ({
              templateId: c.id,
              ...(c.alpha !== undefined ? { alpha: c.alpha } : {}),
              ...(c.beta !== undefined ? { beta: c.beta } : {}),
              ...(c.sampledScore !== undefined ? { sampledScore: c.sampledScore } : {}),
              ...(c.id === bc.id ? {} : { rejectedBecause: "sibling in horizontal OR-edge bundle" }),
            })),
            excluded: excludedNow(),
            status: bt ? bt.status : "failed",
            newShapes: isWinner ? bundleNew : [],
            rationale: `horizontal OR-edge bundle for "${T}" (${bundle.length}-wide parallel fan-out); ${isWinner ? "winning branch" : "shadow sibling"}`,
            poolBefore: iterPoolBefore,
            poolAfter: shapeArr(),
            shadow: !isWinner,
          });
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
      let X = missingTargets.find((s) => live.has(s) && !minted.has(s));
      if (X && !(await mintGovernorAllows(X))) {
        minted.add(X);
        X = undefined;
      }
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
            pickSource = "bridge";
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
      walkTerminationReason = missingNow.length > 0 ? `no producer or constructible payload for missing shapes [${missingNow.join(",")}]` : "opportunistic walk found no applicable pick (empty inferred target)";
      if (filedGap) opts.learningSink?.gapsFiled.push(filedGap);
      console.log(`[goal-host-vessel] walk(${opts.surface}): no shape-feasible step at chain.length=${chain.length} (producedShapes=${producedShapes.size}, missingTargets=${missingNow.length}) — ${filedGap ? `filed capability gap '${filedGap}' for "${missingNow[0]}" (authoring escalation)` : "escalating (stop)"}`);
      if (missingNow.length > 0) {
        tap(`[goal-host-vessel] ${opts.surface}: walk: no pick — missing shapes [${missingNow.join(",")}] have no producer or constructible payload; terminating walk`);
      } else {
        tap(`[goal-host-vessel] ${opts.surface}: walk: no pick — opportunistic walk found no applicable pick (empty inferred target); terminating walk`);
      }
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
    const _stepNew = [...producedShapes].filter((s) => !iterPoolBefore.includes(s));
    recordStep({
      selected: {
        templateId: pick.id, source: pickSource,
        ...(pick.sampledScore !== undefined ? { sampledScore: pick.sampledScore } : {}),
        ...(pick.alpha !== undefined ? { alpha: pick.alpha } : {}),
        ...(pick.beta !== undefined ? { beta: pick.beta } : {}),
      },
      candidates: candidates.map((c) => ({
        templateId: c.id,
        ...(c.alpha !== undefined ? { alpha: c.alpha } : {}),
        ...(c.beta !== undefined ? { beta: c.beta } : {}),
        ...(c.sampledScore !== undefined ? { sampledScore: c.sampledScore } : {}),
        ...(c.id === pick.id ? {} : { rejectedBecause: "not selected (lower goal-gap fit or hollow-scaffold rank)" }),
      })),
      excluded: excludedNow(),
      status: trace.status,
      newShapes: _stepNew,
      rationale: `single-pick ${pickSource}: ${normActivityId(pick.id)} produced ${_stepNew.length} new shape(s)`,
      poolBefore: iterPoolBefore,
      poolAfter: shapeArr(),
    });
    const progressed = producedShapes.size > beforeSize;
    tap(`[goal-host-vessel] walk(${opts.surface}): step ${chain.length} ran ${pick.id} status=${trace.status} new_shapes=${producedShapes.size - beforeSize} pool=${producedShapes.size} chain=${chainExecIds.length}`);
    if (!progressed) {
      consecutiveNoProgress++;
      if (consecutiveNoProgress >= 2) {
        console.log(`[goal-host-vessel] walk(${opts.surface}): 2 consecutive no-progress steps — stopping`);
        walkTerminationReason = "no pool progress for 2 consecutive steps";
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
          console.log(`[goal-host-vessel] walk(${opts.surface}): REACHED early at step ${chain.length} — ${interim.reason ?? "no reason given"}; stopping before pollution. completion_shapes=${JSON.stringify(interim.completion_shapes)}`);
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
  let answerBody: string | undefined;
  let reached = false;

  if (!lastTrace || chain.length === 0) {
    reached = false;
    goalReachReason = walkTerminationReason ?? `walk took 0 shape-feasible steps toward target [${[...target].join(",")}]`;
    console.log(`[goal-host-vessel] walk(${opts.surface}): 0-step termination — ${goalReachReason}`);
  }
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
      // ANSWER-DELIVERY REACH FIX (decision-transparency, 2026-07-07): an obsidian-
      // surface question/request that "reached" on ONLY pre-existing seed shapes
      // produced no new human-consumable answer — force not-reached so the recovery
      // loop retries an approach that actually produces one (mirrors the live defect
      // where "What are you working on?" reached on seed active_note_path/open_note_paths).
      if (isObsidianQuestion && reached === true) {
        const declaredCompletion = verdict?.completion_shapes ?? [];
        const producedCompletion = declaredCompletion.filter((sh) => !seedShapes.has(sh));
        // Flip ONLY when the judge NAMED completion shapes and they are ALL seeds
        // (the live defect shape). If it named none, leave the verdict to the general
        // gate — avoids a false-negative from a judge that omitted completion_shapes.
        if (declaredCompletion.length > 0 && producedCompletion.length === 0) {
          reached = false;
          if (verdict) (verdict as GoalReachVerdict).reached = false;
          goalReachReason = `seed-only completion — the walk reached only on pre-existing seed shapes (${JSON.stringify((verdict?.completion_shapes ?? []).filter((sh) => seedShapes.has(sh)))}); no new human-consumable answer was produced for the obsidian surface`;
        }
      }
      if (verdict && verdict.reached === false) {
        status = "failed";
        goalReachReason = verdict.reason;
        const _abDelta = await penaliseHollowTemplate(lastPick, verdict.reason ?? "goal not reached");
        opts.learningSink?.alphaBetaDelta.push(_abDelta);
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
              if (gapId) opts.learningSink?.gapsFiled.push(gapId);
              if (gapId) console.log(`[goal-host-vessel] walk(${opts.surface}): filed capability gap '${gapId}' for missing shape "${codeGap}" (no live resolver) — authoring escalation`);
            }
          }
        } catch (e) { console.warn("[goal-host-vessel] capability-gap filing error (non-fatal):", (e as Error).message); }
      } else if (verdict && verdict.reached === true) {
        tap(`[goal-host-vessel] walk(${opts.surface}): REACHED via ${chain.length}-step chain — ${verdict.reason ?? "no reason given"}. completion_shapes=${JSON.stringify(verdict.completion_shapes)}`);
        // ANSWER-DELIVERY (decision-transparency, 2026-07-07): a genuinely-reached
        // obsidian question carries a decision-ready markdown answerBody the vault can
        // render, and a produced goal_answer pool shape. The reach-judge rationale
        // prose is an acceptable seed; the produced pool content is the basis.
        if (isQuestionGoal && reached === true) {
          answerBody = [
            `# ${goal.slice(0, 200)}`,
            "",
            verdict.reason ?? "",
            "",
            poolDigest ? `## Basis\n\n${poolDigest.slice(0, 3000)}` : "",
          ].filter(Boolean).join("\n");
          addToPool("goal_answer", answerBody, "rendered answer for obsidian question goal");
        }
        // ── TERMINAL-OUTPUT MATERIALIZATION AS COMPOSITION (host-vault bridge,
        // 2026-07-07) ──────────────────────────────────────────────────────────
        // When a walk terminalizes with durable human-facing knowledge, bridge the
        // output into durable sinks AS TRACED WALK STEPS (source:"bridge"), NOT
        // side-channel writes: an obsidian vault note (via the discovery-routed
        // obsidian:write_note resolver) and, when the finding names a concept, a
        // concept-db writeback carrying dispatch/execution provenance. Every write is
        // a recordStep() so it surfaces in goalWalkState.steps[] and persists in the
        // dispatch record — traced composition. Reuses the in-walk primitives
        // (endpointForShape + rawResolve + recordStep); mints NO template (REUSE
        // BEFORE MINT: composes the existing sink resolvers into the trace).
        //
        // SELECTIVITY (not spammy): bridge ONLY when the goal came from the human
        // obsidian surface (isObsidianSurface — seed obsidian_vessel_endpoint) OR the
        // goal explicitly asks for a durable artifact (a record/save VERB AND a
        // durable NOUN). Internal ticks (boredom measurement/probe/health goals)
        // match neither condition, so they never write a vault note.
        try {
          const durableVerb = /\b(record|save|persist|document|capture|writ|note down|log|jot|archive)\b/i.test(goal);
          const durableNoun = /\b(notes?|findings?|vault|obsidian|concepts?|report|document|memo|knowledge|journal)\b/i.test(goal);
          const durableOutputRequested = durableVerb && durableNoun;
          const shouldBridge = reached === true && (isObsidianSurface || durableOutputRequested);
          if (shouldBridge) {
            const dispatchId = typeof opts.variables.dispatch_id === "string" ? opts.variables.dispatch_id : "";
            const execId = lastExecId ?? dispatchId;
            const bridgeReason = isObsidianSurface
              ? "goal originated from the obsidian human surface (seed obsidian_vessel_endpoint)"
              : "goal explicitly requested a durable artifact";
            // Human-consumable body: prefer the rendered answer, else the produced pool findings.
            const bridgeBody = (answerBody && answerBody.trim().length > 0)
              ? answerBody
              : [`# ${goal.slice(0, 200)}`, "", (verdict.reason ?? ""), "", poolDigest ? `## Findings\n\n${poolDigest.slice(0, 4000)}` : ""].filter(Boolean).join("\n");
            const slugify = (s: string): string =>
              s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "finding";
            const titleText = goal.replace(/\s+/g, " ").trim().slice(0, 80);
            const findingSlug = slugify(titleText);
            const shortDispatch = (dispatchId || execId || String(Date.now())).slice(0, 8);
            // A vessel can ACCEPT a write at transport level yet REFUSE the args in the
            // body (obsidian returns {wrote:false,refused:true,...}); rawResolve treats
            // that non-null content as produced, so detect the soft-refusal explicitly.
            const noteWroteOk = (res: unknown): boolean => {
              if (res == null) return false;
              let o: unknown = res;
              if (typeof o === "string") { try { o = JSON.parse(o); } catch { return true; } }
              if (o && typeof o === "object") { const r = o as Record<string, unknown>; if (r.wrote === false || r.refused === true || r.written === false || r.success === false) return false; }
              return true;
            };

            // ── bridge step 1: concept writeback (concept-db) with provenance ──────
            // Materialize a concept from the finding so knowledge accumulates in the
            // concept graph, carrying dispatch/execution provenance. Only when this
            // succeeds does the vault note wikilink to it (materialize-or-omit).
            let conceptId: string | undefined;
            let conceptTitle: string | undefined;
            {
              const before = shapeArr();
              const conceptData = {
                source_type: "goal_finding",
                content: bridgeBody.slice(0, 4000),
                summary: titleText,
                metadata: { dispatchId, executionId: execId, goal, reached: true, surface: opts.surface, provenance: "goal-host-bridge" },
                pointer: { type: "memo", dispatchId, executionId: execId, provenance: "goal-host-bridge" },
              };
              let ok = false; let detail = "";
              try {
                const ep = await endpointForShape("concept_create_write");
                if (ep) {
                  const res = await rawResolve("concept_create_write", ep.endpoint, ep.resolvePath, { conceptData });
                  if (res != null) {
                    try { const parsed = typeof res === "string" ? JSON.parse(res) : res; const c = parsed as { id?: string }; if (c && typeof c.id === "string") { conceptId = c.id; conceptTitle = titleText; } } catch { conceptId = undefined; }
                    ok = true; detail = conceptId ? `concept ${conceptId}` : "concept created (id not parsed)";
                  } else { detail = lastRawResolveReason ?? "concept write returned empty"; }
                } else { detail = "no vessel advertises concept_create_write"; }
              } catch (e) { detail = `concept write error: ${(e as Error).message}`.slice(0, 200); }
              if (ok) addToPool("concept_create_write_result", { conceptId, summary: titleText }, "bridged concept writeback");
              recordStep({
                selected: { templateId: "bridge:concept_create_write", source: "bridge" },
                candidates: [], excluded: [],
                status: ok ? "reached" : "failed",
                newShapes: ok ? ["concept_create_write_result"] : [],
                rationale: `[bridge] ${bridgeReason} — concept writeback (provenance dispatch=${shortDispatch}): ${detail}`,
                poolBefore: before, poolAfter: shapeArr(), shadow: false,
              });
            }

            // ── bridge step 2: materialize the concept as a vault note (only when a
            // concept was created) so the finding note's wikilink is NEVER dead ─────
            let conceptNoteMaterialized = false;
            if (conceptId) {
              const before = shapeArr();
              const conceptNotePath = `Substrate/Concepts/${findingSlug}.md`;
              const conceptNoteBody = [
                "---", "cssclasses:", "  - substrate-authored", "---",
                `# ${conceptTitle}`, "",
                "Concept materialized by the substrate from a reached goal.", "",
                `- concept-id: \`${conceptId}\``,
                "- source: goal_finding", "",
                `Backlinked from [[Substrate/${findingSlug}-${shortDispatch}]].`,
              ].join("\n");
              let ok = false; let detail = "";
              try {
                const ep = await endpointForShape("obsidian:write_note");
                if (ep) {
                  const res = await rawResolve("obsidian:write_note", ep.endpoint, ep.resolvePath, { path: conceptNotePath, content: conceptNoteBody, dispatch_id: dispatchId, goal, reached: true });
                  ok = noteWroteOk(res); detail = ok ? `wrote ${conceptNotePath}` : (lastRawResolveReason ?? "write refused");
                } else { detail = "no vessel advertises obsidian:write_note"; }
              } catch (e) { detail = `note write error: ${(e as Error).message}`.slice(0, 200); }
              conceptNoteMaterialized = ok; // omit the wikilink if the target didn't materialize
              if (ok) addToPool("obsidian:write_note", { path: conceptNotePath }, "bridged concept note");
              recordStep({
                selected: { templateId: "bridge:obsidian:write_note:concept", source: "bridge" },
                candidates: [], excluded: [],
                status: ok ? "reached" : "failed",
                newShapes: ok ? ["obsidian:write_note"] : [],
                rationale: `[bridge] concept note (materialize-or-omit): ${detail}`,
                poolBefore: before, poolAfter: shapeArr(), shadow: false,
              });
            }

            // ── bridge step 3: the finding note (wikilinks the concept IFF its note
            // materialized — never a dead link, per the rendering contract) ─────────
            {
              const before = shapeArr();
              const notePath = `Substrate/${findingSlug}-${shortDispatch}.md`;
              const conceptLink = conceptNoteMaterialized
                ? `\n\n## Concepts\n\n- [[Substrate/Concepts/${findingSlug}|${conceptTitle}]]`
                : "";
              const noteBody = bridgeBody + conceptLink;
              let ok = false; let detail = "";
              try {
                const ep = await endpointForShape("obsidian:write_note");
                if (ep) {
                  const res = await rawResolve("obsidian:write_note", ep.endpoint, ep.resolvePath, { path: notePath, content: noteBody, dispatch_id: dispatchId, goal, reached: true });
                  ok = noteWroteOk(res); detail = ok ? `wrote ${notePath}` : (lastRawResolveReason ?? "write refused");
                } else { detail = "no vessel advertises obsidian:write_note"; }
              } catch (e) { detail = `note write error: ${(e as Error).message}`.slice(0, 200); }
              if (ok) addToPool("obsidian:write_note", { path: notePath, conceptId }, "bridged finding note");
              recordStep({
                selected: { templateId: "bridge:obsidian:write_note:finding", source: "bridge" },
                candidates: [], excluded: [],
                status: ok ? "reached" : "failed",
                newShapes: ok ? ["obsidian:write_note"] : [],
                rationale: `[bridge] ${bridgeReason} — finding note (provenance dispatch=${shortDispatch}${conceptId ? `, concept=${conceptId}` : ""}): ${detail}`,
                poolBefore: before, poolAfter: shapeArr(), shadow: false,
              });
              tap(`[goal-host-vessel] walk(${opts.surface}): BRIDGE materialized terminal output → sinks (concept=${conceptId ?? "none"}, note=${ok ? notePath : "failed"})`);
            }
          }
        } catch (e) {
          console.warn(`[goal-host-vessel] terminal-output bridge error (non-fatal): ${(e as Error).message}`);
        }
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
      for (const st of satisfierTraces) {
        if (st === lastTrace) continue;
        void persistSatisfierTrace(st);
      }
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
    if (opts.learningSink) opts.learningSink.goalPathRecorded = true;
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
    answerBody,
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
    /** Learning plane: caller-owned accumulator; terminalization consequences pushed here (decision-transparency). */
    learningSink?: LearningConsequences;
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
  let seededOutputShapes = opts.expectedOutputShapes;
  let terminalOutputShapes: string[] | undefined;
  let goalTargetDecision: GoalTargetDecision | null = null;
  if (goal && !opts.callerPinned && !opts.firstTarget) {
    // Lever 4 (2026-06-25): seed the walk's target from the goal. With no caller
    // expected_output_shapes and no pinned target, the walk would run OPPORTUNISTIC
    // and pick the highest-Thompson tick regardless of goal relevance. Infer the
    // goal-satisfying output shape(s) from the known producible vocabulary so the
    // walk backward-chains toward a capability-matched producer. Explicit caller
    // expected_output_shapes always wins (we only infer when it is empty). Fails
    // open to the current opportunistic behavior on inference-empty / LLM-down.
    //
    // GUARD (defect-goal-text-template-literal-injection, 2026-07-05): the
    // inference + derivation-split calls below can throw on unusual goal text
    // (e.g. a goal that quotes a code snippet containing a backtick or a
    // dollar-brace fragment). seededOutputShapes/terminalOutputShapes are
    // hoisted above this block so an exception here still leaves the walk
    // below able to run in opportunistic mode instead of the whole dispatch
    // crashing before runGoalAsPoolWalk or edit-intent routing ever run.
    // goalForRouting is hoisted here for the same reason: assigned by gap-record
    // hydration inside the try, read by the EARLY edit-intent check after it.
    let goalForRouting = goal;
    try {
    let knownShapes: string[] | null = null;
    if (!seededOutputShapes || seededOutputShapes.length === 0) {
      knownShapes = await fetchKnownShapes();
      // WALK-TIME CONCEPT CONSULT (2026-07-04): knowledge before plan. Recall up
      // to 5 related concepts from concept-db and prepend them to the inference
      // prompt so target selection is informed by accumulated shape-sequences and
      // lessons. FAIL-OPEN: concept-db down or slow (4s cap) must not delay the walk.
      let walkConceptContext = "";
      try {
        const cq = encodeURIComponent(goal.slice(0, 300));
        const cr = await fetch(`${CONCEPT_DB_ENDPOINT}/concepts/search?query=${cq}&limit=5`, {
          headers: API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {},
          signal: AbortSignal.timeout(10_000),
        });
        if (cr.ok) {
          const cj = await cr.json() as { concepts?: Array<{ summary?: string; content?: string }> };
          const recalled = (cj.concepts ?? [])
            .map((k) => `- ${String(k.summary ?? "").slice(0, 120)}: ${String(k.content ?? "").slice(0, 300)}`)
            .filter((s) => s.length > 8);
          if (recalled.length > 0) {
            walkConceptContext = `Recalled substrate concepts relevant to this goal (consider them when choosing target shapes):\n${recalled.join("\n")}\n\n`;
            tap(`[walk-concepts] consulted concept-db: ${recalled.length} concepts recalled for goal_hash=${goalHashOf(goal)}`);
          }
        }
      } catch (e) {
        console.warn(`[walk-concepts] consult failed (fail-open): ${(e as Error).message}`);
      }
      // --- capability catalog consultation (fail-open) ---
    try {
      const catalogShapes = knownShapes.filter((s: string) => /^([a-z0-9_-]+):capability_catalog$/.test(s));
      for (const catalogShape of catalogShapes) {
        const nsMatch = /^([a-z0-9_-]+):capability_catalog$/.exec(catalogShape);
        const ns = nsMatch?.[1];
        if (!ns) continue;
        const goalText = typeof goal === 'string' ? goal : JSON.stringify(goal);
        if (!goalText.toLowerCase().includes(ns.toLowerCase())) continue;
        const catalogDiscRes = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
          body: JSON.stringify({ pointer: { type: 'vesselCapability', shape: catalogShape } }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!catalogDiscRes.ok) { console.warn(`[walk-catalog] discovery lookup failed for ${catalogShape}: HTTP ${catalogDiscRes.status}`); continue; }
        const catalogDiscJson = await catalogDiscRes.json() as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string }> } };
        const catalogVessel = catalogDiscJson?.content?.vessels?.[0];
        if (!catalogVessel?.endpoint) continue;
        const catalogResolvePath = catalogVessel.resolve_endpoint ?? '/resolve';
        const catalogRes = await fetch(`${catalogVessel.endpoint.replace(/\/+$/, '')}${catalogResolvePath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
          body: JSON.stringify({ impulse: { pointer: { type: catalogShape } } }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!catalogRes.ok) { console.warn(`[walk-catalog] producer resolve failed for ${catalogShape}: HTTP ${catalogRes.status}`); continue; }
        const catalogJson = await catalogRes.json() as { body?: { entries?: Array<{ shape?: string; description?: string; input_pointer_schema?: { properties?: unknown } }> }; content?: { entries?: Array<{ shape?: string; description?: string; input_pointer_schema?: { properties?: unknown } }> } };
        const raw = catalogJson?.body ?? catalogJson?.content;
          let parsedRaw: { entries?: unknown } | undefined;
          if (typeof raw === 'string') {
            try {
              parsedRaw = JSON.parse(raw) as { entries?: unknown };
            } catch {
              console.warn(`[walk-catalog] unparseable content for ${catalogShape}`);
              continue;
            }
          } else {
            parsedRaw = raw as { entries?: unknown } | undefined;
          }
          const entries = (parsedRaw as { entries?: unknown } | undefined)?.entries ?? (raw as { entries?: unknown } | undefined)?.entries;
        if (!Array.isArray(entries)) { console.warn(`[walk-catalog] no entries[] for ${catalogShape}`); continue; }
        const lines: string[] = [];
        for (const entry of entries.slice(0, 8)) {
          const raw = `- ${entry.shape ?? '?'}: ${entry.description ?? ''} | pointer: ${JSON.stringify((entry.input_pointer_schema as { properties?: unknown } | undefined)?.properties ?? {})}`;
          lines.push(raw.length > 200 ? raw.slice(0, 200) : raw);
        }
        walkConceptContext += `\nCapability catalog for ${ns}:\n${lines.join('\n')}`;
        tap(`[walk-catalog] consulted ${catalogShape}: ${lines.length} entries`);
      }
    } catch (e) {
      console.warn(`[walk-catalog] consult failed (fail-open): ${(e as Error).message}`);
    }
    // --- end capability catalog consultation ---

    // --- gap-record hydration (walk-no-gap-record-hydration-from-goal-text) ---
    // When the goal references a substrateGap id, resolve the record FIRST and
    // inject its summary/metadata into the walk context; if the record cites a
    // repos/<vessel> source file (and the goal itself does not), surface it to the
    // EARLY edit-intent check via goalForRouting so gap-id goals route to
    // feature_compose with the gap's own context. Fail-open on any error.
    try {
      const gapIdMatch = goal.match(/\b(gap-[a-z0-9][a-z0-9-]{5,})\b/i) ?? goal.match(/\bgap\s+([a-z0-9][a-z0-9-]{8,})\b/i);
      const hydrateGapId = gapIdMatch?.[1];
      if (hydrateGapId) {
        const hydRes = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ impulse: { type: "substrateGap", id: hydrateGapId } }),
          signal: AbortSignal.timeout(8_000),
        });
        const hydJson = (await hydRes.json()) as { body?: { gaps?: Array<{ id?: string; summary?: string; classification_metadata?: Record<string, unknown> }> } };
        const hydGap = hydJson?.body?.gaps?.[0];
        if (hydGap && hydGap.id) {
          const hydMeta = JSON.stringify(hydGap.classification_metadata ?? {});
          walkConceptContext += `\nGap record ${hydGap.id}: ${String(hydGap.summary ?? "").slice(0, 500)} | metadata: ${hydMeta.slice(0, 400)}`;
          const hydFile = (hydMeta.match(/repos\/[\w.-]+\/[\w.\/-]+\.\w+/) ?? String(hydGap.summary ?? "").match(/repos\/[\w.-]+\/[\w.\/-]+\.\w+/))?.[0];
          if (hydFile && !/repos\/[\w.-]+\/[\w.\/-]+\.\w+/.test(goal)) {
            goalForRouting = `${goal} (gap cites file: ${hydFile}; fix per gap record: ${String(hydGap.summary ?? "").slice(0, 300)})`;
          }
          tap(`[goal-host-vessel] gap-hydration: injected record ${hydGap.id} (cited file: ${hydFile ?? "none"})`);
        }
      }
    } catch (hydErr) {
      console.warn(`[gap-hydration] failed (fail-open): ${(hydErr as Error).message}`);
    }
    // --- end gap-record hydration ---

    const decision = await inferGoalTargetDecision(goal, knownShapes, {
        decisionCache: inferredTargetDecisionCache,
        llmEndpoint: LLM_VESSEL_ENDPOINT,
        cache: inferredTargetShapeCache,
        complete: (prompt) =>
          routedText(goalHashOf(goal), "goal_target_inference", walkConceptContext + prompt, {
            model: "claude-haiku-4-5-20251001",
          }),
      });
      tap(
        `[goal-host-vessel] ${opts.surface}: goal-target inference ` +
          JSON.stringify({ goal_hash: goalHashOf(goal), inferred_target_shapes: decision.shapes, confidence: decision.confidence, alternatives: decision.alternatives }),
      );
      goalTargetDecision = decision;
      if (decision.shapes.length > 0) seededOutputShapes = decision.shapes;
    }
    // COMPOSITION (derivation-intent, 2026-06-30): when the goal is a derive→emit
    // SEQUENCE ("analyze X then write findings to note Y"), the seeded shapes above
    // are the TERMINAL emit targets. Infer the INTERMEDIATE shape(s) that must be
    // produced first (e.g. problem_detection) and PREPEND them so the walk produces
    // the analysis BEFORE the terminal write — and so the terminal write's content
    // is bound from the produced findings (deferral + content-binding live in the
    // walk's satisfier). Tight classifier returns [] for plain single-step goals →
    // unchanged 1-step behaviour. Only attempted when we have a terminal target set.
    if (seededOutputShapes && seededOutputShapes.length >= 2) {
      // Partition the (multi-shape) target into derive→emit stages. No-op for a
      // single-shape target (the common case) — needs ≥2 shapes to be a derivation.
      const split = await inferDerivationSplit(goal, seededOutputShapes, {
        llmEndpoint: LLM_VESSEL_ENDPOINT,
        cache: inferredTargetShapeCache,
        complete: (prompt) =>
          routedText(goalHashOf(goal), "derivation_split_classification", prompt, {
            model: "claude-haiku-4-5-20251001",
          }),
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
    } catch (err) {
      tap(
        `[goal-host-vessel] ${opts.surface}: goal-target inference / derivation-split threw ` +
          JSON.stringify({ goal_hash: goalHashOf(goal), error: (err as Error).message ?? String(err) }) +
          ` — falling back to opportunistic mode`,
      );
      seededOutputShapes = opts.expectedOutputShapes;
      terminalOutputShapes = undefined;
    }
    try {
      // EARLY edit-intent check: if the goal names a repos/<vessel>/<path>.<ext> file
      // AND contains an edit verb, skip the walk entirely and go straight to feature_compose.
      const earlyEditIntentEnabled = process.env.ROUTE_EDIT_INTENT_TO_COMPOSE !== "0";
      const earlyFileMatch = earlyEditIntentEnabled ? goalForRouting.match(/repos\/([\w.-]+)\/[\w.\/-]+\.\w+/) : null;
      const earlyEditVerb = earlyFileMatch ? /\b(edit|add|insert|append|prepend|change|modify|replace|fix|remove|delete|update|rename|refactor|wire|guard)\b/i.test(goalForRouting) : false;
      if (earlyEditIntentEnabled && earlyFileMatch && earlyEditVerb) {
        const earlyEditFile = earlyFileMatch[0]!;
        const earlyEditVessel = earlyFileMatch[1]!;
        const earlyAfterFile = goalForRouting.slice(goalForRouting.indexOf(earlyEditFile) + earlyEditFile.length);
        const earlyEditLine = earlyAfterFile.match(/^:(\d+)/)?.[1] ?? goalForRouting.match(/\bline\s+~?(\d+)/i)?.[1];
        const earlyEditSite = earlyEditLine ? `${earlyEditFile}:${earlyEditLine}` : earlyEditFile;
        try {
          tap(`[goal-host-vessel] ${opts.surface}: EARLY EDIT-INTENT DETECTED (pre-walk, names ${earlyEditFile}) — routing to feature_compose`);
          const earlySpec = [
            "Make the SMALLEST concrete, verifiable code change to EXISTING vessel source that satisfies this development goal.",
            `Target file — EDIT IT IN PLACE: emit \`edit\` ops on this EXACT path only; do NOT create a new file, vessel, or package.json: ${earlyEditFile}`,
            "The change MUST typecheck.",
            "",
            `GOAL: ${goalForRouting}`,
          ].join("\n");
          const earlyGapId = `route-edit-${goalHashOf(goal)}`;
          let earlyComposeUrl = `${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`;
          try {
            const earlyDr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
              body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "feature_compose" } }),
              signal: AbortSignal.timeout(5_000),
            });
            const earlyDj = await earlyDr.json() as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string }> } };
            const earlyV = earlyDj?.content?.vessels?.[0];
            if (earlyV?.endpoint) {
              earlyComposeUrl = `${earlyV.endpoint.replace(/\/+$/, "")}${asResolvePath(earlyV.resolve_endpoint)}`;
              tap(`[goal-host-vessel] ${opts.surface}: EARLY EDIT-INTENT feature_compose producer resolved via discovery → ${earlyComposeUrl}`);
            }
          } catch { /* discovery unreachable/empty → env fallback carries */ }
          const earlyComposeResp = await fetch(earlyComposeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
            body: JSON.stringify({
              impulse: {
                pointer: {
                  type: "feature_compose",
                  spec: earlySpec,
                  verify_vessels: [`repos/${earlyEditVessel}`],
                  land: true,
                  gap: {
                    id: earlyGapId,
                    summary: goal,
                    category: "edit_intent_route",
                    classification_metadata: { edit_site: earlyEditSite },
                  },
                },
              },
            }),
            signal: AbortSignal.timeout(240_000),
          });
          if (earlyComposeResp.ok) {
            const earlyJ = await earlyComposeResp.json() as Record<string, unknown>;
            const earlyBody = (earlyJ?.body ?? earlyJ ?? {}) as Record<string, unknown>;
            const earlyVerdict = String(earlyBody.verdict ?? "");
            if (earlyVerdict === "FAVORABLE") {
              const earlyCutovers = Array.isArray(earlyBody.cutovers) ? earlyBody.cutovers as Array<Record<string, unknown>> : [];
              let earlyLandedSha: string | null = null;
              for (const c of earlyCutovers) {
                const rr = ((c ?? {}).result ?? {}) as Record<string, unknown>;
                if (rr.push_status === "pushed" && typeof rr.new_git_sha === "string" && rr.new_git_sha.trim()) {
                  earlyLandedSha = rr.new_git_sha.trim();
                  break;
                }
              }
              const earlySummary = typeof earlyBody.summary === "string" && earlyBody.summary.trim()
                ? ` — ${earlyBody.summary.trim().slice(0, 160)}` : "";
              tap(`[goal-host-vessel] ${opts.surface}: EARLY EDIT-INTENT ROUTED to feature_compose for ${earlyEditFile} → verdict=FAVORABLE${earlyLandedSha ? ` landed=${earlyLandedSha}` : " (staged)"}${earlySummary}`);
              return {
                result: null,
                status: "completed" as const,
                selectedTemplateId: "feature_compose",
                completionShapes: ["fileEditResult"],
                attempts: 1,
                goalReachReason: `early edit-intent routed to feature_compose; ${earlyLandedSha ? `landed ${earlyLandedSha}` : "staged FAVORABLE"}${earlySummary}`,
                reached: true,
                executionId: earlyLandedSha ? `feature_compose:${earlyLandedSha}` : undefined,
              };
            }
            tap(`[goal-host-vessel] ${opts.surface}: EARLY EDIT-INTENT feature_compose verdict=${earlyVerdict || "(none)"} — falling through to walk`);
          } else {
            tap(`[goal-host-vessel] ${opts.surface}: EARLY EDIT-INTENT feature_compose HTTP ${earlyComposeResp.status} — falling through to walk`);
          }
        } catch (earlyErr) {
          tap(`[goal-host-vessel] ${opts.surface}: EARLY EDIT-INTENT routing failed (${String((earlyErr as Error)?.message ?? earlyErr)}) — falling through to walk`);
        }
      }
      let walk = await runGoalAsPoolWalk(goal, {
        variables: opts.variables,
        tags: opts.tags,
        parentExecutionId: opts.parentExecutionId,
        compositionChain: opts.compositionChain,
        expectedOutputShapes: seededOutputShapes,
        terminalOutputShapes,
        surface: opts.surface,
        stepSink: opts.stepSink,
        learningSink: opts.learningSink,
      });
      // IN-DISPATCH SATISFIER RETRY: a HOLLOW verdict reached via a vessel-resolve
      // satisfier means the satisfier resolved but produced nothing goal-satisfying —
      // and by filling the pool it short-circuited the bridge-mint path. Retry ONCE
      // with that satisfier suppressed so the walk falls through to the candidate /
      // bridge-mint route instead of the dispatch ending failed after one attempt.
      if (
        walk.reached === false &&
        typeof walk.selectedTemplateId === "string" &&
        walk.selectedTemplateId.startsWith("satisfier:")
      ) {
        const suppressedShape = walk.selectedTemplateId.slice("satisfier:".length);
        console.log(`[goal-host-vessel] ${opts.surface}: hollow satisfier verdict for "${suppressedShape}" — retrying walk once with that satisfier suppressed (bridge-mint/candidate route)`);
        const retryWalk = await runGoalAsPoolWalk(goal, {
          variables: opts.variables,
          tags: opts.tags,
          parentExecutionId: opts.parentExecutionId,
          compositionChain: opts.compositionChain,
          expectedOutputShapes: seededOutputShapes,
          terminalOutputShapes,
          surface: opts.surface,
          stepSink: opts.stepSink,
          learningSink: opts.learningSink,
          suppressSatisfierShapes: [suppressedShape],
        });
        if (retryWalk.reached) return retryWalk;
        walk = retryWalk.attempts > 0 ? retryWalk : walk;
      }
      const editIntentGoal = process.env.ROUTE_EDIT_INTENT_TO_COMPOSE !== "0" && /repos\/[\w.-]+\/[\w.\/-]+\.\w+/.test(goal);
      // A >0-step walk that "reached" via a source_code / analysis READ satisfier does
      // NOT serve an edit-intent goal (read != edit) — this is how a code-edit goal got
      // hollow-satisfied as a source read, bypassing the edit-intent routing below. When
      // the goal names a repos source file with edit language AND the walk produced only
      // read/analysis shapes, fall through to edit-intent routing instead of returning.
      const goalIsEditIntent = /repos\/[\w.-]+\/[\w.\/-]+\.\w+/.test(goal) && /\b(edit|add|insert|append|prepend|change|modify|replace|fix|remove|delete|update|rename|refactor|wire|guard)\b/i.test(goal);
      const EDIT_RESULT_SHAPES = ["fileeditresult", "filewriteresult", "codereplaceresult", "codeinsertresult", "codeaddimportresult", "gitcommitresult"];
      const walkDidNotEdit = (walk.completionShapes ?? []).every((s) => !EDIT_RESULT_SHAPES.includes(String(s).toLowerCase().replace(/[^a-z0-9]/g, "")));
      if (walk.reached === false && !goalIsEditIntent) {
        try { const uf = await universalToolFallback(goal, seededOutputShapes ?? []); if (uf?.reached) return uf; } catch { /* fail-open */ }
      }
      if (walk.attempts > 0 && !(goalIsEditIntent && walkDidNotEdit)) return walk;
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
            // CREATE-INTENT (2026-07-10): a goal authoring a NET-NEW file (a new
            // resolver/module/vessel) must be allowed to create_file — otherwise
            // feature_compose is told "edit in place, do NOT create", tries an `edit`
            // op on a nonexistent path, fails ENOENT → UNFAVORABLE, and the goal falls
            // to the author_new_resolver scaffolder which only emits a `// TODO` stub.
            // For create-intent we permit create_file on the target + the minimal
            // sibling wiring a new resolver needs (three-place rule), so the drafter
            // authors a REAL implementation. Verify (tsc + shape-dispatch) still gates.
            const createIntent = /\b(create|scaffold|net-new)\b/i.test(goal) || /\bnew\s+(resolver|file|vessel|shape|endpoint|module)\b/i.test(goal);
            const spec = createIntent
              ? [
                  "Author the smallest, verifiable code change that satisfies this development goal, drafting a REAL working implementation — never a TODO/stub body.",
                  `Primary target file: ${editFile}. CREATE it with a \`create_file\` op if it does not yet exist; edit it in place if it does.`,
                  "You MAY also create a sibling test file and edit the vessel's resolver-registration files (e.g. src/config.ts and src/routes/impulses.ts, per the three-place rule) when wiring a new resolver requires it. Keep total edits minimal and strictly necessary; do not touch package.json.",
                  "The change MUST typecheck AND pass the vessel's lint/shape-dispatch check.",
                  "",
                  `GOAL: ${goal}`,
                ].join("\n")
              : [
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
                composeUrl = `${v.endpoint.replace(/\/+$/, "")}${asResolvePath(v.resolve_endpoint)}`;
                tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT feature_compose producer resolved via discovery → ${composeUrl}`);
              }
            } catch { /* discovery unreachable/empty → env fallback carries */ }
            const composeInit = () => ({
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
            // Transient-failure retry (capability-gap-edit-intent-compose-transient-failure-retry):
            // a single socket closure / timeout / BUSY must not dump an edit goal onto the
            // recommend path, where non-editing tick templates get selected and β-penalised.
            let resp: Response;
            try {
              resp = await fetch(composeUrl, composeInit());
            } catch (err1) {
              const m = String((err1 as Error)?.message ?? "");
              if (!/timeout|timed out|fetch failed|ECONNREFUSED|ECONNRESET|socket|BUSY/i.test(m)) throw err1;
              tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT transient compose failure (${m}) — retrying once in 5s`);
              await new Promise((r) => setTimeout(r, 5000));
              resp = await fetch(composeUrl, composeInit());
            }
            let j: any = await resp.json().catch(() => ({}));
            let body = (j?.body ?? j ?? {}) as Record<string, any>;
            let verdict = String(body.verdict ?? "");
            if (verdict === "BUSY") {
              console.log("[edit-intent] EDIT-INTENT compose BUSY — waiting 45 s before retry");
              await new Promise<void>((r) => setTimeout(r, 45_000));
              const busyRetryRes = await fetch(composeUrl, composeInit());
              j = await busyRetryRes.json().catch(() => ({}));
              body = (j?.body ?? j ?? {}) as Record<string, any>;
              verdict = String(body.verdict ?? "");
            }
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
              try {
                void persistSatisfierTrace({
                  id: landedSha ? `feature_compose:${landedSha}` : `feature_compose:staged-${editSite}`,
                  templateId: "feature_compose",
                  templateName: "feature_compose (edit-intent)",
                  status: "completed",
                  inputImpulseIds: [],
                  outputImpulseIds: landedSha ? [`git:${landedSha}`] : [],
                  tags: [...(opts.tags ?? []), "reached:true", "completion_shapes:fileEditResult", "edit_intent:true"],
                  metadata: { satisfier: false, edit_intent: true, landed_sha: landedSha, edit_file: editFile, edit_site: editSite, summary: body.summary, op_count: body.op_count, applied: body.applied },
                  tasks: (Array.isArray(body.applied) ? body.applied : [null]).map((op: any, i: number) => ({
                    taskId: `compose-op-${i + 1}`,
                    description: `feature_compose op ${i + 1}`,
                    resolverId: "feature_compose",
                    resolverTier: "pattern" as const,
                    inputImpulseIds: [],
                    outputImpulseIds: [],
                    outputShapes: ["fileEditResult"],
                    success: op ? !!op.ok : true,
                  })),
                });
              } catch { /* durable edit-intent trace is best-effort */ }
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
            } else if (Array.isArray(body.verify) && (body.verify as any[]).some((v: any) => v && v.ok === false)) {
              // Verify (typecheck/shape-dispatch) failure: quote the error lines so the
              // walk log carries the WHY without host journal access.
              const fv = (body.verify as any[]).find((v: any) => v && v.ok === false);
              const out = typeof fv.output === "string" ? fv.output : "";
              const errLines = out.split("\n").filter((l: string) => /error|EXIT=[1-9]/.test(l)).slice(0, 3).join(" | ");
              failDetail = `verify failed (${fv.vessel ?? "?"}): ${(errLines || out.slice(-200)).slice(0, 240)}`;
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
            // STRATEGY ESCALATION (2026-07-10): prose goal-text drafting through
            // feature_compose failed on this file. Measured posterior: byte-anchored
            // tool-driven patching (patch_with_tools ReAct + typecheck verify-on-done)
            // converges where prose drafting does not. Escalate ONCE before failing.
            try {
              tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT ESCALATION — feature_compose verdict=${verdict || "(none)"} for ${editFile}; escalating to patch_with_tools (byte-anchored route)`);
              const pwtResp = await fetch(composeUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
                body: JSON.stringify({ impulse: { pointer: { type: "patch_with_tools", proposal_text: `${spec}\n\nPRIOR FEATURE-COMPOSE FAILURE ON THIS FILE (do not repeat it): ${failWhy}`, target_file: editFile, max_attempts: 2 } } }),
                signal: AbortSignal.timeout(240_000),
              });
              if (pwtResp.ok) {
                const pwtJson = await pwtResp.json() as { success?: boolean; shape?: string; body?: Record<string, unknown> };
                const pwtBody = (pwtJson.body ?? {}) as Record<string, unknown>;
                if (pwtJson.success !== false && (pwtJson.shape === "mitosisStaged" || pwtBody["dispatched"] === true)) {
                  tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT ESCALATION patch_with_tools STAGED mitosis for ${editFile} (${String(pwtBody["mitosis_version_id"] ?? "")})`);
                  return {
                    result: null,
                    status: "completed",
                    selectedTemplateId: "patch_with_tools",
                    completionShapes: ["fileEditResult"],
                    attempts: 2,
                    goalReachReason: `feature_compose verdict=${verdict || "unknown"} (${failWhy}); escalated to patch_with_tools which staged a typecheck-verified mitosis for ${editFile}`,
                    reached: true,
                    executionId: `patch_with_tools:${goalHashOf(goal as string)}`,
                  };
                }
                tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT ESCALATION patch_with_tools did not stage (shape=${String(pwtJson.shape)} detail=${JSON.stringify(pwtBody).slice(0, 160)})`);
              } else {
                tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT ESCALATION patch_with_tools HTTP ${pwtResp.status}`);
              }
            } catch (escErr) {
              tap(`[goal-host-vessel] ${opts.surface}: EDIT-INTENT ESCALATION patch_with_tools call failed (${(escErr as Error).message}) — returning the compose failure`);
            }
            return {
              result: null,
              status: "failed",
              selectedTemplateId: "feature_compose",
              completionShapes: null,
              attempts: 1,
              goalReachReason: `routed edit-intent to feature_compose; verdict=${verdict || "unknown"} (${failWhy})`,
              reached: false,
              // Durable id for the oracle corpus: gate rejections must be labelable.
              // Maps 1:1 to /workspace/proposals/route-edit-<goal_hash>-compose-report.json.
              executionId: `feature_compose:rejected:${goalHashOf(goal as string)}`,
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
                repairUrl = `${v.endpoint.replace(/\/+$/, "")}${asResolvePath(v.resolve_endpoint)}`;
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
  if (!nextTarget && goal && seededOutputShapes && seededOutputShapes.length > 0) {
    nextTarget = (await recommendExcluding(goal, [], null, seededOutputShapes)) ?? undefined;
    if (!nextTarget && goalTargetDecision) {
      for (const alt of goalTargetDecision.alternatives) {
        const altPick = await recommendExcluding(goal, [], null, alt);
        if (altPick) {
          console.log("[goal-host-vessel] OR-alternative framing [" + alt.join(",") + "] has a producer - committing alternative");
          seededOutputShapes = alt;
          nextTarget = altPick;
          break;
        }
      }
    }
    if (!nextTarget) {
      console.log(`[goal-host-vessel] ${opts.surface}: no candidate produces target shapes [${seededOutputShapes.join(",")}] — honest no-producer failure`);
            escalateNoProducerToInvestigation(goal, goalTargetDecision ? goalTargetDecision.confidence : null);
      return { result: null, status: "failed", selectedTemplateId: undefined, completionShapes: null, attempts: 0, goalReachReason: `no template produces the inferred target shapes [${seededOutputShapes.join(", ")}]; capability gap filed by the walk`, reached: false };
    }
  }
  let result: Awaited<ReturnType<typeof host.runGoal>> | null = null;
  let status: "failed" | "completed" = "failed";
  let completionShapes: string[] | null = null;
  let goalReachReason: string | undefined;
  let reached = false;
  let attempt = 0;
  let humanSolicited = false;
  while (attempt < maxAttempts) {
    attempt++;
    result = await host.runGoal(goal ?? `execute template ${nextTarget}`, {
      variables: opts.variables,
      targetTemplateId: nextTarget,
      tags: opts.tags,
      parentExecutionId: opts.parentExecutionId,
      compositionChain: opts.compositionChain,
      expectedOutputShapes: seededOutputShapes ?? opts.expectedOutputShapes,
    });
    status = result.trace.status === "failed" ? "failed" : "completed";
    const selId = result.selectedTemplateId;
    reached = false;
    const producedShapes = [...new Set(((result.trace as { tasks?: Array<{ outputShapes?: string[] }> }).tasks ?? []).flatMap((t) => t.outputShapes ?? []))];
    // Goal-reaching gate: a "completed" execution that didn't reach the goal is a
    // hollow completion — downgrade + β-penalise so Thompson stops reinforcing
    // goal-irrelevant gaming/wrapper templates. completion_shapes surface the
    // (emergent) goal-shaped direction, not a goal-declared target.
    if (goal && status === "completed" && selId) {
      try {
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
          tap(`[goal-host-vessel] goal-reach(${opts.surface}) attempt ${attempt}/${maxAttempts}: HOLLOW via ${selId} — ${verdict.reason}; β-penalised. completion_shapes=${JSON.stringify(verdict.completion_shapes)}`);
        } else if (verdict && verdict.reached === true) {
          tap(`[goal-host-vessel] goal-reach(${opts.surface}) attempt ${attempt}/${maxAttempts}: REACHED via ${selId} — ${verdict.reason ?? "no reason given"}. completion_shapes=${JSON.stringify(verdict.completion_shapes)}`);
          void mintReachedTrace(result.trace as any);  // reach → mint the working trace into a new activity seed
        }
      } catch (e) { console.warn("[goal-host-vessel] goal-reach verify error (non-fatal):", (e as Error).message); }
    } else if (!goal && status === "completed" && selId) {
      try {
        const pinnedTpl = await getTemplateLocalFirst(nextTarget ?? selId).catch(() => null);
        const declared = ((pinnedTpl as { output_shapes?: string[]; outputShapes?: string[] } | null)?.output_shapes ?? (pinnedTpl as { outputShapes?: string[] } | null)?.outputShapes ?? []);
        if (declared.length > 0 && declared.every((s) => producedShapes.includes(s))) {
          reached = true;
          completionShapes = declared;
          tap(`[goal-host-vessel] goal-reach(${opts.surface}) attempt ${attempt}/${maxAttempts}: REACHED (declarative): template output_shapes ⊆ produced`);
        } else if (declared.length > 0) {
          goalReachReason = "declarative: missing " + declared.filter((s) => !producedShapes.includes(s)).join(",");
          tap(`[goal-host-vessel] goal-reach(${opts.surface}) attempt ${attempt}/${maxAttempts}: HOLLOW (declarative): ${goalReachReason}`);
        }
      } catch (e) {
        console.warn("[goal-host-vessel] declarative reach check failed (non-fatal):", (e as Error).message);
      }
    }
    // Per-goal learning: record this attempt's goal -> path -> reach outcome.
    const tr = result.trace as { durationMs?: number; costUsd?: number };
    if (goal && selId) void recordGoalPath(goal, [selId], reached, tr.durationMs ?? 0, tr.costUsd ?? 0);
    if (reached || !goal) break;  // reached (the trace is what the ribosome mints) — or no goal to recover toward
    if (selId) excluded.push(selId);
    // Alter the approach for the next attempt (engine-selected approaches only).
    if (attempt < maxAttempts) {
      const repairKey = repairSignatureOf(classifyFailure(goalReachReason), completionShapes ?? []);
        const alt = await recommendExcluding(goal, excluded, repairKey, seededOutputShapes ?? null);
      if (!alt) {
        // WS5 solicitation-on-recovery: before declaring honest failure, ask a
        // present human (a vault advertising human_input). An answered
        // solicitation injects the human's context and grants ONE retry of the
        // most recently excluded approach; declined / insufficient_context /
        // timeout / no-producer all proceed to the unchanged honest-failure path.
        if (goal && !humanSolicited) {
          humanSolicited = true;
          const evidence = excluded.length > 0
            ? ["| # | approach tried | outcome |", "|---|---|---|", ...excluded.map((id, i) => `| ${i + 1} | ${id.split(":").pop() ?? id} | ${i === excluded.length - 1 ? String(goalReachReason ?? "not reached").slice(0, 120) : "not reached"} |`)].join("\n")
            : "_No approach was even selectable for this goal._";
          const sol = await solicitHumanInput(goal, evidence, typeof opts.variables.dispatch_id === "string" ? opts.variables.dispatch_id : undefined);
          if (sol?.outcome === "answered" && excluded.length > 0) {
            opts.variables.human_input = sol.answer;
            const lastTried = excluded.pop()!;
            nextTarget = lastTried;
            tap(`[goal-host-vessel] ${opts.surface}: human answered solicitation — retrying ${lastTried} with human_input context`);
            continue;
          }
          if (sol) tap(`[goal-host-vessel] ${opts.surface}: human solicitation outcome=${sol.outcome} — proceeding to honest failure`);
        }
        tap(`[goal-host-vessel] ${opts.surface}: no fresh approach after ${attempt} attempts — honest failure`);
        break;
      }
      nextTarget = alt;
      tap(`[goal-host-vessel] ${opts.surface}: altering approach → ${alt} (attempt ${attempt + 1}, excluded ${excluded.length})`);
    }
  }
  return { result, status, selectedTemplateId: result?.selectedTemplateId, completionShapes, attempts: attempt, goalReachReason, reached };
}

// WS5: solicit a present human (a vault advertising human_input via discovery)
// when recovery is about to exhaust approaches. Returns the finished
// solicitation ("answered" carries the human's markdown answer) or null when
// no producer exists / the POST fails (caller proceeds to the unchanged
// honest-failure path). The wait honours the producer's ADVERTISED
// resolve_timeout_ms and is EXTENDED while composition heartbeats arrive —
// never abandon a human mid-answer (hard cap SOLICITATION_MAX_WAIT_MS).
async function solicitHumanInput(goal: string, evidenceMarkdown: string, dispatchId?: string): Promise<PendingSolicitation | null> {
  let producer: { endpoint?: string; resolve_endpoint?: string; resolve_timeout_ms?: number } | null = null;
  try {
    const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "human_input" } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (dr.ok) {
      const dj = await dr.json() as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string; resolve_timeout_ms?: number }> } };
      producer = dj?.content?.vessels?.[0] ?? null;
    }
  } catch { /* no discovery, no solicitation */ }
  if (!producer || typeof producer.endpoint !== "string" || !producer.endpoint) return null;
  const sid = crypto.randomUUID();
  const advertised = typeof producer.resolve_timeout_ms === "number" && producer.resolve_timeout_ms > 0 ? producer.resolve_timeout_ms : 120_000;
  const now = Date.now();
  const sol: PendingSolicitation = { solicitationId: sid, dispatchId, goal, createdAt: now, deadlineAt: now + advertised, maxDeadlineAt: now + SOLICITATION_MAX_WAIT_MS, outcome: "pending", composing: false };
  pendingSolicitations.set(sid, sol);
  const questionMarkdown = [
    "## The substrate needs your input",
    "",
    "The goal below has exhausted its automated approaches. A decision or missing context from you lets one more recovery attempt run.",
    "",
    "**Goal**",
    "",
    "> " + goal.slice(0, 400).replace(/\n/g, "\n> "),
    "",
    "**What was tried**",
    "",
    evidenceMarkdown,
    "",
    "Answer in the card, or decline (\"not now\"), or mark it as lacking the context you would need.",
  ].join("\n");
  try {
    const r = await fetch(`${producer.endpoint.replace(/\/+$/, "")}${asResolvePath(producer.resolve_endpoint)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
      body: JSON.stringify({ type: "human_input", pointer: { type: "human_input", solicitation_id: sid, dispatch_id: dispatchId ?? null, question_markdown: questionMarkdown, timeout_ms: advertised, respond_via: { shape: "solicitationResponse_write", heartbeat_shape: "solicitationHeartbeat_write" } } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) { pendingSolicitations.delete(sid); return null; }
    try { await r.body?.cancel(); } catch { /* ignore */ }
  } catch {
    pendingSolicitations.delete(sid);
    return null;
  }
  console.log(`[goal-host-vessel] solicitation ${sid} posted to human_input producer (advertised timeout ${advertised}ms, cap ${SOLICITATION_MAX_WAIT_MS}ms)`);
  while (Date.now() < sol.deadlineAt && sol.outcome === "pending") {
    await new Promise((res) => setTimeout(res, 2_000));
  }
  if (sol.outcome === "pending") sol.outcome = "timeout";
  pendingSolicitations.delete(sid);
  console.log(`[goal-host-vessel] solicitation ${sid} outcome=${sol.outcome}${sol.composing ? " (composition heartbeats were received)" : ""}`);
  return sol;
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
// Bus events go to the LOCAL activity-api regardless of where the trace store
// (ACTIVITY_API_ENDPOINT) lives: the WS subscribers (concept-db, ribosome,
// workbench) attach to the local broadcaster, and forwarding the lifecycle
// firehose over a WAN hub link is what congested the uplink on 2026-07-05 —
// stalled trace POSTs were cut mid-body ("Unterminated string") and burst
// POSTs lost their sockets. Override with EVENT_BUS_ENDPOINT when a
// deployment wants the bus elsewhere.
const EVENT_BUS_ENDPOINT = process.env.EVENT_BUS_ENDPOINT ?? PRODUCER_DISCOVERY_ENDPOINT;
const busSink = new BusForwardingEventSink({
  inner: noopInnerSink,
  activityApiEndpoint: EVENT_BUS_ENDPOINT,
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
          if (v.protocol === "libp2p" && Array.isArray(v.libp2p_multiaddr) && v.libp2p_multiaddr[0]) {
            // libp2p-reachable peer (e.g. the operator-host obsidian sidecar): its
            // advertised endpoint is a NATed loopback, so route the resolve through the
            // local federation-transport egress (goal-host carries no libp2p deps),
            // passing the peer multiaddr as ?target=. Mirrors endpointForShape so a
            // remote-vessel shape used as a TASK RESOLVER routes the same way the walk
            // satisfier already does — fixes resolver_not_registered for obsidian:* etc.
            // discoveredVia=peer check removed: locally-registered ingress-sidecar vessels
            // also use libp2p transport and must route via the egress regardless of discovery origin.
            endpoint = FED_TRANSPORT_EGRESS.replace(/\/+$/, "");
            resolvePath = `/egress/resolve?target=${encodeURIComponent(v.libp2p_multiaddr[0])}${(v as { id?: string }).id ? `&vessel=${encodeURIComponent((v as { id?: string }).id as string)}` : ""}`;
          } else if (v.discoveredVia === "peer" && v.peerEndpoint) {
            endpoint = v.peerEndpoint.replace(/\/+$/, "");
            resolvePath = asResolvePath(v.resolve_endpoint);
          } else {
            endpoint = v.endpoint.replace(/\/+$/, "");
            resolvePath = asResolvePath(v.resolve_endpoint);
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
      const rp = asResolvePath(typeof v.resolve_endpoint === "string" ? v.resolve_endpoint : undefined);
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
  const requeueId = typeof variables.requeue_dispatch_id === "string" ? variables.requeue_dispatch_id : "";
        const dispatchId = requeueId && !executionStore.has(requeueId) ? requeueId : crypto.randomUUID();
  pruneStore();
  // Requeued dispatches carry their lineage: requeuedAt arms the one-requeue
  // cap in drainInterruptedRequeue (a second interruption terminalizes instead
  // of requeueing again), and requeueOf preserves the ancestor dispatch id so
  // attempt history stays traceable for composition-graph accounting.
  const record: DispatchRecord = { dispatchId, startedAt: Date.now(), status: "running", goal: typeof goal === "string" ? goal : undefined, reached: null, operator, ...(requeueId ? { requeuedAt: Date.now(), requeueOf: requeueId } : {}) };
  executionStore.set(dispatchId, record);
  persistDispatchStore();
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
              try {
                const rr = await routedComplete(goalHashOf(goal as string), "template_candidate_ranking", {
                  prompt, model: "claude-haiku-4-5-20251001", maxTokens: 10,
                });
                if (rr.ok) {
                  const lr = (rr.json ?? {}) as { resolved?: boolean; content?: string; body?: { content?: string } };
                  const ans = ((lr.content ?? lr.body?.content) ?? "").trim().match(/^\d+/)?.[0];
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
      const learningSink: LearningConsequences = { alphaBetaDelta: [], gapsFiled: [], goalPathRecorded: false, oracleLabelWritten: false };
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
        learningSink,
      });
      record.status = seek.status;
      // Honest goal-reach verdict, threaded up from the walk's GoalReachVerdict
      // through GoalSeekResult.reached — distinct from status (template exit).
      record.reached = seek.reached;
      const usedKnownPath = typeof seek.selectedTemplateId === "string" && seek.selectedTemplateId.length > 0 && seek.attempts === 1 && seek.reached === true;
      const satisfierOnly = typeof seek.selectedTemplateId === "string" && seek.selectedTemplateId.startsWith("satisfier:");
      const execution_path: string = (() => {
        if (usedKnownPath) return "learned_pathway";
        if (satisfierOnly) return "satisfier";
        if (seek.executionId && String(seek.executionId).startsWith("universal-tool-fallback:")) return "universal_tool_fallback";
        return "fresh_derivation";
      })();
      const walk_tier: string = seek.attempts != null ? String(seek.attempts) : "0";
      effectiveTags.push(`execution_path:${execution_path}`, `walk_tier:${walk_tier}`);
      record.walkLog = [...(record.walkLog ?? []), `[dispatch] execution_path=${execution_path} walk_tier=${walk_tier}`];
      record.inferenceConfidence = typeof goal === "string" ? (inferredTargetDecisionCache.get(goalHashOf(goal))?.confidence ?? null) : null;
      // Reward the LLM router: attribute every routed selection this dispatch made
      // (buffered under the goal hash) to the final reach verdict — α on reach, β on
      // hollow. Fire-and-forget; never blocks the dispatch.
      void flushRouterFeedback(goalHashOf(String(goal ?? "")), seek.reached === true);
      record.walkLog = walkStepSink;
      record.executionId = seek.executionId ?? seek.result?.trace?.id ?? `goal-seek:no-trace:${goalHashOf(String(goal ?? ""))}`;
      record.selectedTemplateId = seek.selectedTemplateId;
      (record as { attempts?: number }).attempts = seek.attempts;
      (record as { completionShapes?: string[] | null }).completionShapes = seek.completionShapes;
      if (seek.goalReachReason) record.goalReachReason = seek.goalReachReason;
      record.learning = learningSink;
      if (seek.answerBody) record.answerBody = seek.answerBody;
      persistDispatchStore();
      // Decision-log hygiene: a finished dispatch closes its own auto_draft_decision
      // rows (opened by emitAuthoringDecision, keyed on Bun.hash(goal)) so the gap
      // store stops accumulating one open decision-log row per distinct goal.
      // Fire-and-forget; close writes with no matching open row are skipped by the
      // dev-vessel write resolver (close_without_open_row).
      void closeAuthoringDecisions(typeof goal === "string" ? goal : "");
      // WHY affordance: operator dispatches render their walk reasoning into the vault.
      if (operator && walkStepSink.length > 0) {
        try {
          const dr2 = await fetch(DISCOVERY_ENDPOINT + "/resolve", { method: "POST", headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: "ApiKey " + API_KEY } : {}) }, body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "obsidian:write_note" } }), signal: AbortSignal.timeout(5000) });
          const dj2 = await dr2.json() as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string }> } };
          const wv2 = dj2?.content?.vessels?.[0];
          if (wv2?.endpoint) {
            const whyPath = "Substrate/Dispatches/" + dispatchId.slice(0, 8) + ".md";
            const whyBody = "# Why: " + String(goal ?? "").slice(0, 120) + "\n\n**reached:** " + (record.reached ? "yes" : "no") + (record.goalReachReason ? " - " + String(record.goalReachReason).slice(0, 300) : "") + "\n\n## Walk\n" + walkStepSink.map((l) => "- " + l).join("\n").slice(0, 6000) + "\n";
            await fetch(wv2.endpoint.replace(/\/+$/, "") + (asResolvePath(wv2.resolve_endpoint)), { method: "POST", headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: "ApiKey " + API_KEY } : {}) }, body: JSON.stringify({ impulse: { pointer: { type: "obsidian:write_note", path: whyPath, content: whyBody, dispatch_id: dispatchId, goal: String(goal ?? "").slice(0, 200), reached: record.reached === true } } }), signal: AbortSignal.timeout(8000) });
          }
        } catch { /* vault surface unreachable - reasoning still lives in the dispatch record */ }
      }
    } catch (err) {
      // A thrown dispatch never produced a reach verdict — the goal was not reached.
      record.reached = false;
      record.error = (err as Error).message;
      if (walkStepSink.length) record.walkLog = walkStepSink;
      persistDispatchStore();
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
            await fetch(wv.endpoint.replace(/\/+$/, "") + (asResolvePath(wv.resolve_endpoint)), {
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

  if (type === "goal_dispatch_async" || type === "goalDispatchAsync") {
    // Async dispatch over the federation ingress: enqueue via the SAME async path as
    // /run-goal and return the dispatchId immediately (fast — fits the ingress forward
    // cap, unlike synchronous goal_execution which runs the whole goal). Lets a remote
    // vault dispatch a goal over the relay; results stream back over the WS sync.
    const g = typeof body.goal === "string" ? body.goal : (typeof pointer.goal === "string" ? pointer.goal : undefined);
    if (!g) return Response.json({ error: "goal is required for goalDispatchAsync" }, { status: 400 });
    const synthetic = new Request("http://local/run-goal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: g,
        variables: (body.variables ?? pointer.variables ?? {}),
        tags: (body.tags ?? pointer.tags),
        expected_output_shapes: (body.expected_output_shapes ?? pointer.expected_output_shapes),
        operator: (body.operator ?? pointer.operator),
      }),
    });
    return handleRunGoal(synthetic);
  }

  if (type === "activeDispatches") {
    const dispatches = [...executionStore.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 50)
      .map((r) => ({
        dispatchId: r.dispatchId,
        goal: typeof r.goal === "string" ? r.goal.slice(0, 200) : null,
        status: r.status,
        reached: r.reached ?? null,
        operator: r.operator ?? null,
        startedAt: r.startedAt,
        selectedTemplateId: r.selectedTemplateId ?? null,
        executionId: r.executionId ?? null,
        learning: (r as { learning?: LearningConsequences }).learning ?? null,
        answerBody: (r as { answerBody?: string }).answerBody ?? null,
      }));
    return Response.json({ resolved: true, shape: "activeDispatches", body: { dispatches } });
  }
  if (type === "goalWalkState") {
    const wid = (typeof body.dispatchId === "string" ? body.dispatchId : undefined)
      ?? (typeof pointer.dispatchId === "string" ? pointer.dispatchId : undefined);
    if (!wid) return Response.json({ resolved: false, shape: "goalWalkState", error: "dispatchId is required" }, { status: 400 });
    const rec = executionStore.get(wid);
    if (!rec) return Response.json({ resolved: false, shape: "goalWalkState", error: "dispatch not found" }, { status: 404 });
    return Response.json({
      resolved: true,
      shape: "goalWalkState",
      body: {
        dispatchId: rec.dispatchId,
        status: rec.status,
        reached: rec.reached ?? null,
        poolShapes: rec.poolShapes ?? [],
        pendingTargets: rec.pendingTargets ?? [],
        poolEvents: rec.poolEvents ?? [],
        walkLog: Array.isArray(rec.walkLog) ? rec.walkLog.slice(-60) : [],
        currentStep: rec.walkLog && rec.walkLog.length > 0 ? rec.walkLog[rec.walkLog.length - 1] : null,
        steps: Array.isArray((rec as { steps?: WalkStep[] }).steps) ? (rec as { steps?: WalkStep[] }).steps : [],
        learning: (rec as { learning?: LearningConsequences }).learning ?? null,
        answerBody: (rec as { answerBody?: string }).answerBody ?? null,
      },
    });
  }
  if (type === "poolImpulse_write") {
    const wid = (typeof body.dispatchId === "string" ? body.dispatchId : undefined)
      ?? (typeof pointer.dispatchId === "string" ? pointer.dispatchId : undefined);
    const shape = (typeof body.shape === "string" ? body.shape : undefined)
      ?? (typeof pointer.shape === "string" ? pointer.shape : undefined);
    const content = "content" in body ? body.content : (pointer as Record<string, unknown>)["content"];
    const summary = (typeof body.summary === "string" ? body.summary : undefined)
      ?? (typeof pointer.summary === "string" ? pointer.summary : undefined);
    if (!wid || !shape) return Response.json({ resolved: false, shape: "poolImpulse_write", error: "dispatchId and shape are required" }, { status: 400 });
    const rec = executionStore.get(wid);
    if (!rec) return Response.json({ resolved: false, shape: "poolImpulse_write", error: "dispatch not found" }, { status: 404 });
    if (rec.status !== "running") return Response.json({ resolved: false, shape: "poolImpulse_write", error: `dispatch is ${rec.status}, not running` }, { status: 409 });
    const q = injectedPoolImpulses.get(wid) ?? [];
    q.push({ shape, content: content ?? null, summary });
    injectedPoolImpulses.set(wid, q);
    return Response.json({ resolved: true, shape: "poolImpulse_write", body: { queued: q.length, dispatchId: wid } });
  }
  if (type === "solicitationHeartbeat_write") {
    const sid = (typeof body.solicitationId === "string" ? body.solicitationId : undefined)
      ?? (typeof pointer.solicitationId === "string" ? pointer.solicitationId : undefined);
    if (!sid) return Response.json({ resolved: false, shape: "solicitationHeartbeat_write", error: "solicitationId is required" }, { status: 400 });
    const sol = pendingSolicitations.get(sid);
    if (!sol || sol.outcome !== "pending") return Response.json({ resolved: false, shape: "solicitationHeartbeat_write", error: "no pending solicitation with that id" }, { status: 404 });
    sol.composing = true;
    sol.deadlineAt = Math.min(Date.now() + SOLICITATION_HEARTBEAT_EXTENSION_MS, sol.maxDeadlineAt);
    return Response.json({ resolved: true, shape: "solicitationHeartbeat_write", body: { solicitationId: sid, deadlineAt: sol.deadlineAt, maxDeadlineAt: sol.maxDeadlineAt } });
  }
  if (type === "solicitationResponse_write") {
    const sid = (typeof body.solicitationId === "string" ? body.solicitationId : undefined)
      ?? (typeof pointer.solicitationId === "string" ? pointer.solicitationId : undefined);
    const outcome = (typeof body.outcome === "string" ? body.outcome : undefined)
      ?? (typeof pointer.outcome === "string" ? pointer.outcome : undefined);
    if (!sid || !outcome || !["answered", "declined", "insufficient_context"].includes(outcome)) {
      return Response.json({ resolved: false, shape: "solicitationResponse_write", error: "solicitationId and outcome (answered|declined|insufficient_context) are required" }, { status: 400 });
    }
    const sol = pendingSolicitations.get(sid);
    if (!sol || sol.outcome !== "pending") return Response.json({ resolved: false, shape: "solicitationResponse_write", error: "no pending solicitation with that id" }, { status: 404 });
    sol.outcome = outcome as "answered" | "declined" | "insufficient_context";
    sol.answer = "answer" in body ? body.answer : (pointer as Record<string, unknown>)["answer"];
    return Response.json({ resolved: true, shape: "solicitationResponse_write", body: { solicitationId: sid, outcome: sol.outcome } });
  }
  if (type !== "goal_execution" && type !== "activity_execution") {
    return Response.json(
      { error: `unknown shape '${type}'; supported: goal_execution, activity_execution, activeDispatches, goalWalkState, poolImpulse_write, solicitationResponse_write, solicitationHeartbeat_write` },
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
    // Reward the LLM router for every routed selection this dispatch made.
    void flushRouterFeedback(goalHashOf(String(goal ?? "")), seek.reached === true);

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
  requeuedAt?: number;
  requeueOf?: string;
  inferenceConfidence?: number | null;
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
  /** Live walk state (goalWalkState read shape): pool shape snapshot + pending target shapes, updated at each walk iteration. */
  poolShapes?: string[];
  pendingTargets?: string[];
  poolEvents?: Array<{ shape: string; source: string; at: number }>;
  /** Structured per-step decision tree (decision-transparency, 2026-07-07); surfaced by goalWalkState. */
  steps?: WalkStep[];
  /** Learning consequences accumulated at terminalization (decision-transparency, 2026-07-07). */
  learning?: LearningConsequences;
  /** Decision-ready markdown answer for an obsidian question goal (answer-delivery reach fix). */
  answerBody?: string;
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
    // Key the decision-log id on the GOAL, not the per-dispatch UUID: repeat dispatches of the same goal upsert one row in the gap store instead of accumulating duplicates (observed 177 open rows for 24 distinct goals).
    const goalText = typeof classification_metadata.goal === "string" ? classification_metadata.goal : "";
    const gap = {
      id: `auto_draft_decision:${goalText.length > 0 ? Bun.hash(goalText).toString(36) : ((classification_metadata.dispatchId as string | undefined) ?? crypto.randomUUID())}:${category}`,
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

// closeAuthoringDecisions — on dispatch completion, close the auto_draft_decision
// gap rows this goal opened via emitAuthoringDecision (same Bun.hash(goal) id
// scheme). The write resolver skips closes whose class has no open row, so firing
// all four categories unconditionally is safe and idempotent.
async function closeAuthoringDecisions(goalText: string): Promise<void> {
  if (goalText.length === 0) return;
  // Mirror emitAuthoringDecision's id scheme exactly: every emit call site passes
  // goal.slice(0, 200) into classification_metadata, so the open row's id hashes
  // the SLICED goal — hashing the full text here would miss every goal >200 chars.
  const hash = Bun.hash(goalText.slice(0, 200)).toString(36);
  for (const category of ["auto_draft_triggered", "auto_draft_reused", "auto_draft_authored", "auto_draft_fallback_recommend"]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
        body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: { id: `auto_draft_decision:${hash}:${category}`, category, source: "goal_host_auto_draft", summary: `[closed by dispatch completion] ${goalText.slice(0, 120)}`, detected_at: new Date().toISOString(), status: "closed" } } } }),
        signal: ctrl.signal,
      });
      try { await res.body?.cancel(); } catch { /* swallow */ }
    } catch { /* fire-and-forget */ } finally {
      clearTimeout(timer);
    }
  }
}

// Cap store at 100 records to prevent unbounded growth across long uptime.
const executionStore = new Map<string, DispatchRecord>();
// Pool insertion (poolImpulse_write): human-contributed impulses queued per
// dispatchId; the running walk drains this queue at the top of each iteration.
// Strictly additive — injected shapes unlock candidates on the next rescan.
const injectedPoolImpulses = new Map<string, Array<{ shape: string; content: unknown; summary?: string }>>();
// Human-solicitation (WS5): pending solicitations awaiting a human answer.
// Populated by solicitHumanInput (recovery loop); a present human vault answers
// via solicitationResponse_write; typing in the answer card sends
// solicitationHeartbeat_write keepalives which EXTEND the deadline — the system
// NEVER takes fallback action while a response is being composed (hard cap
// SOLICITATION_MAX_WAIT_MS).
interface PendingSolicitation {
  solicitationId: string;
  dispatchId?: string;
  goal: string;
  createdAt: number;
  deadlineAt: number;
  maxDeadlineAt: number;
  outcome: "pending" | "answered" | "declined" | "insufficient_context" | "timeout";
  answer?: unknown;
  composing: boolean;
}
const pendingSolicitations = new Map<string, PendingSolicitation>();
const SOLICITATION_HEARTBEAT_EXTENSION_MS = 90_000;
const SOLICITATION_MAX_WAIT_MS = 30 * 60 * 1000;
const DISPATCH_STORE_PATH = "/workspace/goal-host-dispatches.json";
const interruptedRequeue: DispatchRecord[] = [];
async function drainInterruptedRequeue(): Promise<void> {
  for (const r of interruptedRequeue) {
    try {
      if (r.requeuedAt || (typeof r.goal === "string" && /repos\/[^\s"']+\.[a-zA-Z]+/.test(r.goal))) {
        r.status = "failed";
        r.reached = false;
        r.error = "interrupted: goal-host restarted (cutover) while this dispatch was in flight";
        if (!r.executionId) r.executionId = "interrupted:" + r.dispatchId;
        if (!r.selectedTemplateId) r.selectedTemplateId = "interrupted:none";
        continue;
      }
      executionStore.delete(r.dispatchId);
      await fetch("http://127.0.0.1:" + PORT + "/run-goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: r.goal, variables: { requeue_dispatch_id: r.dispatchId } })
      });
      console.log("[goal-host-vessel] requeued interrupted dispatch " + r.dispatchId);
      await new Promise((res) => setTimeout(res, 5000));
    } catch (err) {
      console.warn("[goal-host-vessel] requeue failed for " + r.dispatchId + ": " + (err as Error).message);
    }
  }
  interruptedRequeue.length = 0;
  persistDispatchStore();
}
setTimeout(() => {
  drainInterruptedRequeue().catch((err) => console.warn("[goal-host-vessel] drain error: " + (err as Error).message));
}, 15000);
try {
  const saved = JSON.parse(await Bun.file(DISPATCH_STORE_PATH).text()) as DispatchRecord[];
  for (const r of saved) {
    if (!r || !r.dispatchId) continue;
    const wasRunning = r.status === "running";
    if (wasRunning) {
      let reconciled = false;
      if (typeof r.goal === "string" && /edit repos\//i.test(r.goal)) {
        try {
          const h = goalHashOf(r.goal);
          const reportFile = Bun.file("/workspace/proposals/route-edit-" + h + "-compose-report.json");
          if (await reportFile.exists()) {
            const report = JSON.parse(await reportFile.text()) as Record<string, unknown>;
            if (report.verdict === "FAVORABLE" && reportFile.lastModified > r.startedAt) {
              const cs = Array.isArray(report.cutovers) ? report.cutovers as Array<Record<string, unknown>> : [];
              let sha = "reconciled";
              for (const c of cs) { const res = (c?.result ?? {}) as Record<string, unknown>; if (typeof res.new_git_sha === "string" && res.new_git_sha) { sha = res.new_git_sha; break; } }
              r.status = "completed"; r.reached = true; r.executionId = "feature_compose:" + sha; r.selectedTemplateId = "feature_compose"; r.error = undefined;
              console.log("[goal-host-vessel] reconciled interrupted edit-intent dispatch " + r.dispatchId + " -> landed " + sha);
              reconciled = true;
            }
          }
        } catch { /* fall through to interrupted marking */ }
      }
      if (!reconciled) { interruptedRequeue.push(r); }
    }
    // No-resume guard (2026-07-09): edit-intent goals (any goal naming a concrete
    // repos/<vessel>/<path>.<ext> source file — same predicate as EDIT-INTENT
    // routing above) must NOT auto-resume on boot. Their compose may have already
    // landed + cut over — the cutover restart is what interrupted them — so blind
    // replay re-applies the same edit forever (the route-edit-26279b2b loop).
    // Resume chains are also depth-capped: a dispatch that is itself a resume
    // (tags carry resumed_from:) is not resumed again.
    const isEditIntentGoal = typeof r.goal === "string" && /repos\/[\w.-]+\/[\w.\/-]+\.\w+/.test(r.goal);
    const isResumeChild = Array.isArray((r as { tags?: string[] }).tags) && ((r as { tags?: string[] }).tags ?? []).some((t) => t.startsWith("resumed_from:"));
    if (wasRunning && typeof r.goal === "string" && !(r as { resumed_as?: string }).resumed_as && Date.now() - r.startedAt < 600000 && !isEditIntentGoal && !isResumeChild) { const old = r as DispatchRecord & { resumed_as?: string }; setTimeout(() => { fetch("http://127.0.0.1:" + PORT + "/run-goal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal: old.goal, tags: ["resumed_from:" + old.dispatchId] }) }).then(async (res) => { const j = await res.json() as { dispatchId?: string }; if (j.dispatchId) { old.resumed_as = j.dispatchId; persistDispatchStore(); } }).catch(() => { }); }, 20000); }
    executionStore.set(r.dispatchId, r);
  }
  console.log("[goal-host-vessel] dispatch store: restored " + executionStore.size + " records from disk");
} catch { /* first boot or unreadable - start empty */ }
function persistDispatchStore(): void {
  const snapshot = JSON.stringify([...executionStore.values()]);
  Bun.write(DISPATCH_STORE_PATH, snapshot).catch((err) => {
    console.warn("[goal-host-vessel] dispatch store persist failed: " + (err as Error).message);
  });
}
setInterval(persistDispatchStore, 5000);
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
        in_flight: [...executionStore.values()].filter((r) => r.status === "running").length,
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
