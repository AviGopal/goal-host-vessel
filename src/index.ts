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

import { appendFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import {
  GoalHost,
  DiscoveryRegistrationLoop,
  createLLMPort,
} from "@avigopal/ias-executor-ts";
import { BusForwardingEventSink } from "@avigopal/ias-executor-ts/adapters";
import type { EventSink } from "@avigopal/ias-executor-ts";

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
    const ordered = memRing.length < MEM_RING_SIZE
      ? memRing.slice()
      : memRing.slice(memRingHead).concat(memRing.slice(0, memRingHead));
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
const DISCOVERY_ENDPOINT = process.env.DISCOVERY_VESSEL_ENDPOINT ?? "http://127.0.0.1:8100";
const API_KEY = process.env.GOAL_HOST_VESSEL_API_KEY ?? process.env.METABOB_API_KEY ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const LLM_VESSEL_ENDPOINT = process.env.LLM_VESSEL_ENDPOINT;

const SHAPES = ["goal_execution", "activity_execution"] as const;
const VERSION = "0.1.0";
const DEV_VESSEL_ENDPOINT = process.env.DEVELOPMENT_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
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

const host = new GoalHost({
  llm,
  activityApiEndpoint: ACTIVITY_API_ENDPOINT,
  apiKey: API_KEY,
  discoveryEndpoint: DISCOVERY_ENDPOINT,
  enableAgentFill: true,
  eventSink: (useNoOpSink ? pureNoOpSink : boundedSink) as unknown as typeof busSink,
  ...(DISABLE_SUBSCRIBERS ? { subscriberTemplates: [] } : {}),
});

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
    async resolve(context: Record<string, unknown>) {
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
    async resolve(context: Record<string, unknown>) {
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
function interpolateProxyValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([\w]+(?:\.[\w]+)*)\}\}/g, (match, path: string) => {
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
  if (Array.isArray(value)) return value.map((v) => interpolateProxyValue(v, variables));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateProxyValue(v, variables);
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
      const config = interpolateProxyValue(configRaw, variables) as Record<string, unknown>;
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
      const config = interpolateProxyValue(configRaw, variables) as Record<string, unknown>;
      const pointer: Record<string, unknown> = { type: shape, ...variables, ...config };

      // 1. Resolve the producer endpoint via discovery (lazy → survives restarts).
      const discCtrl = new AbortController();
      const discTimer = setTimeout(() => discCtrl.abort(), 5_000);
      let endpoint = "";
      let resolvePath = "/resolve";
      try {
        const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
          body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
          signal: discCtrl.signal,
        });
        const dj = await dr.json() as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string }> } };
        const v = dj?.content?.vessels?.[0];
        if (!v?.endpoint) throw new Error(`discovery: no vessel advertises ${shape}`);
        endpoint = v.endpoint.replace(/\/+$/, "");
        resolvePath = v.resolve_endpoint || "/resolve";
      } finally {
        clearTimeout(discTimer);
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
    const j = await r.json() as { content?: { vessels?: Array<{ shapes?: string[] }> } };
    const vessels = j?.content?.vessels ?? [];
    const obs = new Set<string>();
    for (const v of vessels) {
      for (const s of (v.shapes ?? [])) {
        if (typeof s === "string" && s.startsWith("obsidian:")) obs.add(s);
      }
    }
    if (obs.size > 0) {
      shapes = [...obs];
      discoveredProxyShapes = shapes;
      console.log(`[goal-host-vessel] discovered obsidian capability surface from registry: ${shapes.length} shapes`);
    }
  } catch (err) {
    console.warn(`[goal-host-vessel] obsidian shape discovery failed, using fallback (${DISCOVERY_PROXY_SHAPE_FALLBACK.length}): ${(err as Error).message}`);
  }
  const added: string[] = [];
  for (const shape of shapes) {
    if (registeredProxyShapes.has(shape)) continue;
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
  const record: DispatchRecord = { dispatchId, startedAt: Date.now(), status: "running" };
  executionStore.set(dispatchId, record);

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
      // Fix A: exploration picks (score < threshold but fallback_tier != "refused")
      // should be executed by ias-executor directly — autoDraft only fires when
      // fallback_tier=refused (genuinely nothing returned, no exploration picks).
      const fallbackTier = data.fallback_tier ?? "none";
      if (top) {
        // At least one recommendation exists (even with score=0, exploration=true).
        // Let ias-executor handle selection; autoDraft would preempt a valid pick.
        console.log(`[goal-host-vessel] auto-draft skipped: ${recommendations.length} exploration pick(s) available (top_score=${topScore.toFixed(3)}, fallback_tier=${fallbackTier})`);
        return;
      }
      if (fallbackTier !== "refused") {
        // No top recommendation but fallback_tier indicates some tier returned
        // something — still not a hard empty; skip autoDraft.
        console.log(`[goal-host-vessel] auto-draft skipped: fallback_tier=${fallbackTier} (not refused), no template selected but not a hard gap`);
        return;
      }
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
                const llmRes = await fetch("http://127.0.0.1:8220/resolve", {
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
                  try { (globalThis as { Bun?: { gc?: (b: boolean) => number } }).Bun?.gc?.(true); } catch {}
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
      await fetch("http://127.0.0.1:8090/v2/impulses/resolve", {
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
              console.log(`[goal-host-vessel] auto-draft: authored ${authored.id}; promoting + overriding targetTemplateId`);
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
      const effectiveTags = [...(tags ?? []), ...sigTag, ...mitosisTags, ...dispatcherTag];

      await autoDraft();
      const effectiveTargetId = targetTemplateId ?? authoredTemplateId;
      if (authoredTemplateId && !targetTemplateId) {
        console.log(`[goal-host-vessel] /run-goal: using auto-authored template ${authoredTemplateId} for goal`);
      }
      if (!effectiveTargetId && goal) {
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
      const result = await host.runGoal(goal ?? `execute template ${effectiveTargetId}`, {
        variables,
        targetTemplateId: effectiveTargetId,
        tags: effectiveTags,
        parentExecutionId,
        compositionChain,
        expectedOutputShapes,
      });
      record.status = result.trace.status === "failed" ? "failed" : "completed";
      record.executionId = result.trace.id;
      record.selectedTemplateId = result.selectedTemplateId;
    } catch (err) {
      record.status = "failed";
      record.error = (err as Error).message;
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
          await fetch("http://127.0.0.1:8090/v2/impulses/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}` },
            body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap } } }),
            signal: AbortSignal.timeout(8000),
          });
          console.log(`[goal-host-vessel] operator_goal_unservable gap emitted: ${gapId}`);
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
            await fetch("http://127.0.0.1:8090/v2/impulses/resolve", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}` },
              body: JSON.stringify({ impulse: { pointer: { type: "fs_write", path: `/workspace/patterns/${patternId}.json`, content: JSON.stringify(cluster, null, 2) } } }),
              signal: AbortSignal.timeout(8000),
            });
            // Dispatch the real-chain author (async; do not await its completion here).
            void fetch("http://127.0.0.1:8210/run-goal", {
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
    const result = await host.runGoal(goal ?? `execute template ${targetTemplateId}`, {
      variables,
      targetTemplateId,
      parentExecutionId,
      compositionChain,
    });
    return Response.json({
      resolved: true,
      shape: type === "goal_execution" ? "goalExecution" : "activityExecution",
      executionId: result.trace.id,
      status: result.trace.status,
      selectedTemplateId: result.selectedTemplateId,
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
  executionId?: string;
  selectedTemplateId?: string;
  error?: string;
  /** State-space signature computed at dispatch time; threaded onto trace tags. */
  stateSignature?: StateSignatureBody;
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
        executionId: record.executionId,
        selectedTemplateId: record.selectedTemplateId,
        error: record.error,
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
