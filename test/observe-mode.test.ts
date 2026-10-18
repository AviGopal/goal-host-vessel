// OBSERVE IS SIDE-EFFECT-FREE (src/observe-mode.ts). Measured: an observe probe was routed to feature_compose, which
// drafted and ran the suite, and the same dispatch REMEMBERED a failure, tombstoned a reached command and mirrored a
// reach-gate lesson to concept-db. Pinned here, on the pure module and the walk egress guard:
//   (a) under observe every side effect is skipped and the skip is recorded once per (dispatch, effect);
//   (b) control: a learn (or absent) mode skips nothing and records nothing;
//   (c) a walk egress writing the gap store is refused before any fetch under observe; control: under learn it goes out,
//       and an observe dispatch's own pool writes still go out;
//   (d) a gap-write target is dropped from the walk's target set under observe, kept under learn;
//   (e) the feature_compose hand-off fields carry learning_mode "observe" (and land:false) only for an observe dispatch.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  isObserveRefusedWrite, observeComposeFields, observeComposeOutcome, observeComposeReason, observeDropFrom, observeDropShapes,
  observeEgressRefusal, observeSkipCounters, observeSkipLine, observeSkips, resetObserveSkips,
} from "../src/observe-mode";
import { isWalkEgressRefused, setWalkEgressLearningModeReader, walkEgressFetch } from "../src/walk-egress-guard";

let calls: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  resetObserveSkips();
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; setWalkEgressLearningModeReader(() => undefined); });

const gapWriteInit = (): RequestInit => ({ method: "POST", body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: { id: "g1", summary: "x" } } } }) });

describe("(a)/(b) observeSkips", () => {
  it("observe: every effect is skipped, recorded once per dispatch and effect", () => {
    const lines: string[] = [];
    const rec = (l: string) => lines.push(l);
    expect(observeSkips("observe", "d1", "failure_memory", rec)).toBe(true);
    expect(observeSkips("observe", "d1", "failure_memory", rec)).toBe(true);
    expect(observeSkips("observe", "d1", "reached_command_evict", rec)).toBe(true);
    expect(observeSkips("observe", "d2", "failure_memory", rec)).toBe(true);
    expect(lines).toEqual([
      "[observe] skipped failure_memory (dispatch observe)",
      "[observe] skipped reached_command_evict (dispatch observe)",
      "[observe] skipped failure_memory (dispatch observe)",
    ]);
    expect(observeSkipCounters()).toEqual({ failure_memory: 3, reached_command_evict: 1 });
    expect(observeSkipLine("reach_gate_lesson")).toBe("[observe] skipped reach_gate_lesson (dispatch observe)");
  });
  it("control: learn and an absent mode skip nothing and record nothing", () => {
    const lines: string[] = [];
    for (const effect of ["failure_memory", "reached_command_bank", "reached_command_evict", "reach_gate_lesson", "gap_write"] as const) {
      expect(observeSkips("learn", "d1", effect, (l) => lines.push(l))).toBe(false);
      expect(observeSkips(undefined, "d1", effect, (l) => lines.push(l))).toBe(false);
    }
    expect(lines).toEqual([]);
    expect(observeSkipCounters()).toEqual({});
  });
});

describe("(c) the walk egress refuses an observe dispatch's gap write", () => {
  it("observeEgressRefusal reads the site's shape and every type the body carries", () => {
    expect(observeEgressRefusal("observe", "substrateGap_write", {})).toContain("observe: refused before egress");
    expect(observeEgressRefusal("observe", "shellResult", { impulse: { pointer: { type: "development-vessel:substrateGap_write" } } })).not.toBeNull();
    expect(observeEgressRefusal("observe", "x", { type: "substrateGap_write" })).not.toBeNull();
    expect(observeEgressRefusal("observe", "poolImpulse_write", { impulse: { pointer: { type: "poolImpulse_write" } } })).toBeNull();
    expect(observeEgressRefusal("learn", "substrateGap_write", {})).toBeNull();
    expect(isObserveRefusedWrite("substrateGap")).toBe(false);
  });
  it("observe: walkEgressFetch throws the guard's refusal and never calls fetch; the drop is recorded", async () => {
    setWalkEgressLearningModeReader(() => ({ learningMode: "observe", dispatchId: "d-obs" }));
    let err: unknown = null;
    try { await walkEgressFetch("substrateGap_write", "http://dv/v2/impulses/resolve", gapWriteInit()); } catch (e) { err = e; }
    expect(isWalkEgressRefused(err)).toBe(true);
    expect(calls).toEqual([]);
    expect(observeSkipCounters()).toEqual({ gap_write: 1 });
  });
  it("control: under learn the same gap write goes out", async () => {
    setWalkEgressLearningModeReader(() => ({ learningMode: "learn", dispatchId: "d-learn" }));
    const r = await walkEgressFetch("substrateGap_write", "http://dv/v2/impulses/resolve", gapWriteInit());
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["http://dv/v2/impulses/resolve"]);
  });
  it("control: an observe dispatch's ordinary (non-gap) egress goes out", async () => {
    setWalkEgressLearningModeReader(() => ({ learningMode: "observe", dispatchId: "d-obs" }));
    await walkEgressFetch("poolImpulse_write", "http://dv/pool", { method: "POST", body: JSON.stringify({ impulse: { pointer: { type: "poolImpulse_write", shape: "note" } } }) });
    expect(calls).toEqual(["http://dv/pool"]);
  });
});

describe("(d) the walk's target set", () => {
  it("observe drops a gap-write target (recorded); learn keeps it", () => {
    const lines: string[] = [];
    expect(observeDropShapes(["substrateGap_write", "shellResult"], "observe", "d1", (l) => lines.push(l))).toEqual(["shellResult"]);
    expect(lines).toEqual(["[observe] skipped gap_write (dispatch observe)"]);
    expect(observeDropShapes(["substrateGap_write", "shellResult"], "learn", "d1")).toEqual(["substrateGap_write", "shellResult"]);
    const t = new Set(["substrateGap_write", "memoryNote"]);
    observeDropFrom(t, "observe", "d2");
    expect([...t]).toEqual(["memoryNote"]);
    const u = new Set(["substrateGap_write"]);
    observeDropFrom(u, undefined, "d3");
    expect([...u]).toEqual(["substrateGap_write"]);
  });
});

describe("(e) the feature_compose hand-off", () => {
  it("carries learning_mode observe only for an observe dispatch", () => {
    expect(observeComposeFields("observe")).toEqual({ learning_mode: "observe", land: false, skip_push: true });
    // spread after the pointer's land:true, the observe fields win
    expect({ land: true, ...observeComposeFields("observe") }.land).toBe(false);
    expect({ land: true, ...observeComposeFields("learn") }.land).toBe(true);
    expect(observeComposeFields("learn")).toEqual({});
    expect(observeComposeFields(undefined)).toEqual({});
    expect(observeComposeReason("FAVORABLE", "ops=2")).toBe("observe: dry run, not landed — feature_compose verdict=FAVORABLE; ops=2");
    expect(observeComposeOutcome("UNFAVORABLE", "x")).toEqual({ goalReachReason: "observe: dry run, not landed — feature_compose verdict=UNFAVORABLE; x", reached: false, abstain: { kind: "observe-dry-run", cuts: [] } });
  });
});
