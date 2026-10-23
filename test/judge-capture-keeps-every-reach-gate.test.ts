// Row: judge-capture-keeps-only-the-last-reach-gate-record-per-dispatch-so-a-floor-verdict-overwrites-the-walks-credited-one
// (KNOWN-WRONG 15; also the-judge-capture-keeps-only-the-last-reach-gate-input-per-dispatch-and-the-floor-erases-…).
//
// captureJudgeInput wrote `judge_input[entry] = rec`, so when the floor's reach gate ran after a reaching walk, the
// floor's not-reached record replaced the walk's graded one, and corpus and replay reads leaned not-reached. Every
// reachGate write is now kept: the replaced record moves to metadata.judge_input_superseded (oldest first, bounded),
// and judge_input.reachGate is still the latest, so every existing reader reads what it read before.
import { describe, expect, test } from "bun:test";
import * as capture from "../src/judge/capture";
import {
  captureJudgeInput, floorVerdictInput, noteLlmJudge, reachGateInput, withCaptureTarget,
  type CaptureTarget, type ReachGateCaptureArgs,
} from "../src/judge/capture";

const BASE: ReachGateCaptureArgs = {
  goal: "List the subdirectories of repos/example-vessel/src", originalTargets: ["shellResult"], deliverables: null, targetsSeenByWalk: null,
  reframedFrom: null, persistedWrites: [], landed: null, landedEffective: null, producedShapes: [], postReachSink: null, toolsTotal: null, groundedReads: null,
  outputImpulses: null, consumedInChain: null, surface: "walk", digest: null, taskSummary: "walk(1 steps)", commandEvidence: null,
  walkEvidence: null, judgeView: null,
};
type Meta = { judge_input?: Record<string, { input: Record<string, unknown>; verdict: unknown; calls: number; llm: unknown }>; judge_input_superseded?: { reachGate: Array<{ input: Record<string, unknown>; verdict: { reached?: boolean }; calls: number }>; dropped: number } };
const meta = (t: CaptureTarget) => t.metadata as unknown as Meta;

describe("MUST-FAIL: a later reach gate never erases an earlier one", () => {
  test("a floor gate after a reaching walk keeps the walk's graded record", async () => {
    const t: CaptureTarget = {};
    await withCaptureTarget(t, async () => {
      noteLlmJudge({ reached: true, reason: "the listing is in the pool" });
      captureJudgeInput("reachGate", () => reachGateInput({ ...BASE, reframedFrom: ["fileContent"] }), { reached: true, reason: "the listing is in the pool" });
      captureJudgeInput("reachGate", () => reachGateInput({ ...BASE, surface: "floor" }), { reached: false, reason: "deterministic:no-output" });
    });
    const m = meta(t);
    expect(m.judge_input!.reachGate!.input["surface"]).toBe("floor");
    expect(m.judge_input!.reachGate!.calls).toBe(2);
    expect(m.judge_input_superseded?.reachGate.length).toBe(1);
    const walk = m.judge_input_superseded!.reachGate[0]!;
    expect(walk.input["surface"]).toBe("walk");
    expect(walk.verdict.reached).toBe(true);
    expect(walk.calls).toBe(1);
    // the walk's re-frame origin survives the floor's call (the floor records reframed_from null)
    expect(walk.input["reframed_from"]).toEqual(["fileContent"]);
    expect(m.judge_input_superseded!.dropped).toBe(0);
  });

  test("three gate calls keep the first two, oldest first, and the third as the latest", async () => {
    const t: CaptureTarget = {};
    await withCaptureTarget(t, async () => {
      for (let i = 1; i <= 3; i++) captureJudgeInput("reachGate", () => reachGateInput({ ...BASE, taskSummary: `call ${i}` }), { reached: i === 2 });
    });
    const m = meta(t);
    expect(m.judge_input_superseded!.reachGate.map((r) => r.calls)).toEqual([1, 2]);
    expect(m.judge_input_superseded!.reachGate.map((r) => r.verdict.reached)).toEqual([false, true]);
    expect(m.judge_input!.reachGate!.calls).toBe(3);
  });

  test("the kept records are bounded: oldest dropped first, and counted", async () => {
    const t: CaptureTarget = {};
    const n = 40;
    await withCaptureTarget(t, async () => {
      for (let i = 1; i <= n; i++) captureJudgeInput("reachGate", () => reachGateInput({ ...BASE, digest: `${i}:` + "x".repeat(3_000) }), { reached: false });
    });
    const s = meta(t).judge_input_superseded!;
    const cap = (capture as Record<string, unknown>)["CAPTURE_SUPERSEDED_CAP_BYTES"];
    expect(cap).toBe(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(s), "utf8")).toBeLessThanOrEqual(cap as number);
    expect(s.dropped).toBeGreaterThan(0);
    expect(s.dropped + s.reachGate.length).toBe(n - 1);
    // the newest superseded record is the call just before the latest
    expect(s.reachGate[s.reachGate.length - 1]!.calls).toBe(n - 1);
  });
});

describe("CONTROL: a dispatch with one gate, and every other entry, records as before", () => {
  test("one reachGate call: no superseded key; the record is the same", async () => {
    const t: CaptureTarget = {};
    await withCaptureTarget(t, async () => { captureJudgeInput("reachGate", () => reachGateInput(BASE), { reached: true }); });
    expect("judge_input_superseded" in (t.metadata as object)).toBe(false);
    expect(meta(t).judge_input!.reachGate!.calls).toBe(1);
  });

  test("the floor verdict still consumes the latest gate; other entries never supersede", async () => {
    const t: CaptureTarget = {};
    await withCaptureTarget(t, async () => {
      captureJudgeInput("reachGate", () => reachGateInput(BASE), { reached: true });
      noteLlmJudge({ reached: false, reason: "floor judge" });
      captureJudgeInput("reachGate", () => reachGateInput({ ...BASE, surface: "floor" }), { reached: false });
      const fv = () => floorVerdictInput({ ...BASE, surface: "floor", answerText: "", verdictReason: null, seededEvidence: true, toolsOk: 0, authoredAnswer: false });
      captureJudgeInput("floorVerdict", fv, { reached: false });
      captureJudgeInput("floorVerdict", fv, { reached: false });
    });
    const m = meta(t);
    expect(m.judge_input!.floorVerdict!.llm).toEqual(m.judge_input!.reachGate!.llm);
    expect(m.judge_input!.floorVerdict!.calls).toBe(2);
    expect(m.judge_input_superseded!.reachGate.length).toBe(1);
  });
});
