// FAIL-OPEN, NEVER SILENT: a capture that throws never stops the decision it records from being delivered, and every
// such throw is COUNTED (capture_error) and logged with its count. Capture outside a dispatch does nothing and is
// counted as unbound. The observers hand back the callee's own promise, so they cannot change what the caller awaits.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  captureCounters, captureJudgeInput, noteRoutingHandOff, observeWriteReadback, reachGateInput, resetCaptureCounters,
  routingRecorder, withCaptureTarget, type CaptureTarget,
} from "../../src/judge/capture";

let warned: string[] = [];
const realWarn = console.warn;
beforeEach(() => { resetCaptureCounters(); warned = []; console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); }; });
afterEach(() => { console.warn = realWarn; });

/** A decision site in miniature: decide, capture, deliver. */
function site(capture: () => void): { reached: boolean; reason: string } {
  const verdict = { reached: false, reason: "deterministic:fixture — decided before capture" };
  capture();
  return verdict;
}

describe("capture throws -> the verdict is still delivered and capture_error is counted", () => {
  test("an input builder that throws", async () => {
    const target: CaptureTarget = {};
    const out = await withCaptureTarget(target, async () => site(() => captureJudgeInput("reachGate", () => { throw new Error("builder exploded"); }, { reached: false })));
    expect(out).toEqual({ reached: false, reason: "deterministic:fixture — decided before capture" });
    expect(captureCounters().capture_error).toBe(1);
    expect(captureCounters().captured).toBe(0);
    expect(target.metadata?.judge_input?.reachGate).toBeUndefined();
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain("[judge-capture] capture_error #1 entry=reachGate");
  });

  test("a verdict that cannot be serialized (a cycle, a BigInt)", async () => {
    const target: CaptureTarget = {};
    const cyclic: Record<string, unknown> = { reached: true }; cyclic["self"] = cyclic;
    const args = { goal: "g", originalTargets: null, deliverables: null, targetsSeenByWalk: null, reframedFrom: null, persistedWrites: null, landed: null, producedShapes: [], postReachSink: null, toolsTotal: null, groundedReads: null, outputImpulses: null, consumedInChain: null, surface: null, digest: null, taskSummary: null, commandEvidence: null, walkEvidence: null, judgeView: null };
    await withCaptureTarget(target, async () => {
      expect(site(() => captureJudgeInput("reachGate", () => reachGateInput(args), cyclic)).reached).toBe(false);
      expect(site(() => captureJudgeInput("floorVerdict", () => reachGateInput(args), { n: 1n })).reached).toBe(false);
    });
    expect(captureCounters().capture_error).toBe(2);
    expect(warned[1]).toContain("capture_error #2 entry=floorVerdict");
  });

  test("a routing hand-off on a record whose metadata is unwritable", async () => {
    const target = Object.freeze({}) as CaptureTarget;
    await withCaptureTarget(target, async () => { noteRoutingHandOff({ goal: "Edit repos/example-vessel/src/a.ts", composeGapId: "route-edit-fixture", editSite: "repos/example-vessel/src/a.ts" }); });
    expect(captureCounters().capture_error).toBe(1);
  });

  test("a routing recorder whose bookkeeping throws still passes every call through unchanged", async () => {
    const rr = routingRecorder();
    const search = rr.search(async () => ["repos/example-vessel/src/a.ts"]);
    const hits = await search("term");
    expect(hits).toEqual(["repos/example-vessel/src/a.ts"]);
    // finish on a goal the predicates cannot read (its string conversion throws) throws inside; the record is null and counted.
    const unreadable = { toString(): string { throw new Error("unreadable goal"); } } as unknown as string;
    expect(rr.finish(unreadable, unreadable)).toBeNull();
    expect(captureCounters().capture_error).toBe(1);
  });
});

describe("observers never change what the caller awaits", () => {
  test("observeWriteReadback returns the very same promise, resolved or rejected", async () => {
    const target: CaptureTarget = {};
    await withCaptureTarget(target, async () => {
      const ok = Promise.resolve({ persisted: false as const });
      expect(observeWriteReadback("note_write", ok)).toBe(ok);
      const bad = Promise.reject(new Error("read-back failed"));
      expect(observeWriteReadback("note_write", bad)).toBe(bad);
      await expect(bad).rejects.toThrow("read-back failed");
    });
  });

  test("a routing recorder's wrapped search returns the callee's own promise and rejection", async () => {
    const rr = routingRecorder();
    const p = Promise.reject(new Error("search down"));
    const wrapped = rr.search(() => p);
    expect(wrapped("t")).toBe(p);
    await expect(p).rejects.toThrow("search down");
    const tapped: string[] = [];
    rr.tap((m) => tapped.push(m))("a decision line");
    expect(tapped).toEqual(["a decision line"]);
  });
});

describe("outside a dispatch, capture does nothing and is counted as unbound", () => {
  test("no bound record", () => {
    captureJudgeInput("floorShortcut", () => ({ goal: "g" }), { allowed: false });
    noteRoutingHandOff({ goal: "g", composeGapId: "x", editSite: "y" });
    expect(captureCounters()).toEqual({ captured: 0, capture_error: 0, unbound: 2 });
    expect(warned).toEqual([]);
  });
});
