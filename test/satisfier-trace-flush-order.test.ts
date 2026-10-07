// A WALK'S SATISFIER STEP TRACES ARE PERSISTED BEFORE ANY TRACE THAT NAMES THEM (check-first, 2026-10-07).
//
// Measured on node 1 (activity-api 2f0451e, chain credit by point lookup): every chain-credit miss was a walk satisfier
// step (walk-satisfier-N-<ts>) whose execution row landed about 2 minutes AFTER the engine pick traces
// (learned-composition-*, auto-bridge-*) that name it in composition_chain, e.g. walk-satisfier-5-1791378965133 row
// created 13:18:45Z, its consumers ingested 13:16:48-13:17:10Z. Chain credit runs at the consumer's ingest, so the
// producer was never credited. Cause (goal-host src/index.ts): a satisfier step's trace is kept in memory
// (satisfierTraces) and POSTed only at walk end, fire-and-forget, after the end-of-walk reach judge, while the engine
// POSTs each later pick's trace (awaited) during the walk, and the walk composites are recorded before the step loop.
//
// THE RULE PINNED HERE:
//   - makeSatisfierFlusher(traces, persist) returns flush(except?): it persists, in order and each AWAITED before the
//     next, every trace in `traces` not yet persisted (except `except`), exactly once across calls.
//   - The walk awaits it BEFORE each host.runTemplate (whose engine trace names the steps in its compositionChain),
//     BEFORE recording either walk composite, and at walk end (in place of the fire-and-forget loop).
// The walk itself needs a live host, so the wiring is pinned on the source; the ordering logic on the exported function.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realFetch = globalThis.fetch;
let mod: Record<string, any>;
beforeAll(async () => {
  globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  mod = (await import("../src/index")) as Record<string, any>;
  globalThis.fetch = realFetch;
});

type T = { id: string };
/** A persist stub that resolves later than it is called, recording start and finish order. */
function recorder() {
  const events: string[] = [];
  const persist = async (t: T) => { events.push(`start:${t.id}`); await new Promise((r) => setTimeout(r, 5)); events.push(`done:${t.id}`); };
  return { events, persist };
}
const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

describe("satisfier step traces are flushed, awaited, before anything that names them", () => {
  test("MUST-FAIL: makeSatisfierFlusher is exported", () => {
    expect(typeof mod.makeSatisfierFlusher).toBe("function");
  });

  test("MUST-FAIL: flush persists each unpersisted trace once, in order, each awaited before the next", async () => {
    const traces: T[] = [{ id: "walk-satisfier-1-a" }, { id: "walk-satisfier-2-b" }];
    const { events, persist } = recorder();
    const flush = mod.makeSatisfierFlusher(traces, persist);
    await flush();
    expect(events).toEqual(["start:walk-satisfier-1-a", "done:walk-satisfier-1-a", "start:walk-satisfier-2-b", "done:walk-satisfier-2-b"]);
    traces.push({ id: "walk-satisfier-3-c" });
    await flush();
    expect(events.slice(4)).toEqual(["start:walk-satisfier-3-c", "done:walk-satisfier-3-c"]); // the first two are not re-posted
  });

  test("MUST-FAIL: flush(except) leaves that trace for the walk-end durable path", async () => {
    const last = { id: "walk-satisfier-9-z" };
    const traces: T[] = [{ id: "walk-satisfier-8-y" }, last];
    const { events, persist } = recorder();
    await mod.makeSatisfierFlusher(traces, persist)(last);
    expect(events).toEqual(["start:walk-satisfier-8-y", "done:walk-satisfier-8-y"]);
  });

  test("MUST-FAIL (wiring): every walk host.runTemplate is preceded by an awaited flush", () => {
    const sites = [...SRC.matchAll(/host\.runTemplate\(/g)].map((m) => m.index!);
    expect(sites.length).toBe(2);
    for (const at of sites) expect(SRC.slice(Math.max(0, at - 1600), at)).toMatch(/await flushSatisfierTraces\(\)/);
  });

  test("MUST-FAIL (wiring): both walk composites flush before they are recorded, and the walk-end loop is awaited", () => {
    for (const marker of ["await satisfierTraceSink.record(_failedComposite", "await satisfierTraceSink.record(composite as unknown"]) {
      const at = SRC.indexOf(marker);
      expect(at).toBeGreaterThan(0);
      expect(SRC.slice(at - 400, at)).toMatch(/await flushSatisfierTraces\(lastTrace\)/);
    }
    expect(SRC).not.toMatch(/for \(const st of satisfierTraces\) \{\s*if \(st === lastTrace\) continue;\s*void persistSatisfierTrace\(st\);/);
  });

  test("CONTROL: a walk with no satisfier steps (empty list) persists nothing", async () => {
    const { events, persist } = recorder();
    await mod.makeSatisfierFlusher([], persist)();
    expect(events).toEqual([]);
  });
});

// BOUNDED (qa 2026-10-07): awaiting the sink before every pick must not let a hung activity-api stall the walk. Each
// flush waits at most a SHAPED deadline (selection-tuning satisfierFlushDeadlineMs: policy file -> default), then
// logs and continues, leaving the trace queued (re-awaited, never re-posted) for the next flush.
describe("the satisfier flush is bounded by a shaped deadline", () => {
  test("MUST-FAIL: a persist that never resolves => flush returns within the deadline, and the trace is not re-posted", async () => {
    let calls = 0;
    const hung = () => { calls++; return new Promise<void>(() => {}); };
    const flush = mod.makeSatisfierFlusher([{ id: "walk-satisfier-1-hung" }], hung, () => 50);
    const t0 = Date.now();
    await flush();
    expect(Date.now() - t0).toBeLessThan(1_000);
    await flush(); // a second flush re-awaits the same in-flight post rather than posting again
    expect(calls).toBe(1);
  });

  test("MUST-FAIL: the deadline is a shaped tuning value (satisfierFlushDeadlineMs), defaulting to 20 s", async () => {
    const st = await import("../src/selection-tuning");
    expect(st.SELECTION_TUNING_DEFAULTS.satisfierFlushDeadlineMs).toBe(20_000);
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "flush-deadline-"));
    try {
      mkdirSync(join(root, "policies"), { recursive: true });
      writeFileSync(join(root, "policies", "selection-tuning.json"), JSON.stringify({ satisfierFlushDeadlineMs: 7_000 }));
      st._resetSelectionTuningCache();
      expect((await st.resolveSelectionTuning(root)).satisfierFlushDeadlineMs).toBe(7_000);
    } finally { st._resetSelectionTuningCache(); rmSync(root, { recursive: true, force: true }); }
  });

  test("MUST-FAIL (wiring): the walk's flusher reads the shaped deadline", () => {
    expect(SRC).toMatch(/makeSatisfierFlusher\(satisfierTraces, persistSatisfierTrace, [\s\S]{0,160}satisfierFlushDeadlineMs/);
  });

  test("CONTROL: a fast persist is fully awaited within the deadline", async () => {
    const { events, persist } = recorder();
    await mod.makeSatisfierFlusher([{ id: "walk-satisfier-1-fast" }], persist, () => 5_000)();
    expect(events).toEqual(["start:walk-satisfier-1-fast", "done:walk-satisfier-1-fast"]);
  });
});
