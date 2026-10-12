// SIZE CAP: one captured record is at most 32 KB serialized. The digest excerpt is cut first; then the largest other
// strings; then long arrays. Every cut carries a marker saying how much was cut, and a capped record says so.
import { describe, expect, test } from "bun:test";
import {
  CAPTURE_DISPATCH_CAP_BYTES, CAPTURE_RECORD_CAP_BYTES, CAPTURE_TRUNCATION_MARKER, attachRoutingInput, capRecord,
  captureJudgeInput, floorShortcutInput, floorVerdictInput, noteRoutingHandOff, reachGateInput, routingRecorder,
  withCaptureTarget, type CaptureTarget, type ReachGateCaptureArgs,
} from "../../src/judge/capture";

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");
const BASE: ReachGateCaptureArgs = {
  goal: "Write a note listing every stage of the build", originalTargets: ["memoryNote_write"], deliverables: null, targetsSeenByWalk: null,
  reframedFrom: null, persistedWrites: [], landed: null, producedShapes: [], postReachSink: null, toolsTotal: null, groundedReads: null,
  outputImpulses: null, consumedInChain: null, surface: "walk", digest: null, taskSummary: "walk(1 steps)", commandEvidence: null,
  walkEvidence: null, judgeView: null,
};

async function captured(entry: "reachGate" | "floorVerdict", input: Parameters<typeof captureJudgeInput>[1]) {
  const target: CaptureTarget = {};
  await withCaptureTarget(target, async () => { captureJudgeInput(entry, input, { reached: false }); });
  return target.metadata!.judge_input![entry]!;
}

describe("a captured record is capped at 32 KB, with a marker", () => {
  test("the cap is 32 KB", () => { expect(CAPTURE_RECORD_CAP_BYTES).toBe(32 * 1024); });

  test("an oversize digest excerpt is truncated first, with a marker, and the rest is kept whole", async () => {
    const digest = "d".repeat(100_000);
    const rec = await captured("reachGate", () => reachGateInput({ ...BASE, digest }));
    expect(bytes(rec)).toBeLessThanOrEqual(CAPTURE_RECORD_CAP_BYTES);
    const d = rec.input["digest_excerpt"] as string;
    expect(d).toContain(CAPTURE_TRUNCATION_MARKER);
    expect(d.length).toBeGreaterThan(10_000); // cut to fit (the 16 KB dispatch cap is the tighter one here), not emptied
    expect(rec.input["goal"]).toBe(BASE.goal);
    expect(rec.capped).toBe(true);
  });

  test("an oversize field other than the excerpt is cut too", async () => {
    const rec = await captured("floorVerdict", () => floorVerdictInput({ ...BASE, surface: "floor", digest: "short digest", answerText: "a".repeat(120_000), verdictReason: null, seededEvidence: false, toolsOk: 0, authoredAnswer: true }));
    expect(bytes(rec)).toBeLessThanOrEqual(CAPTURE_RECORD_CAP_BYTES);
    expect(rec.input["answer_text"] as string).toContain(CAPTURE_TRUNCATION_MARKER);
    expect(rec.input["digest_excerpt"]).toBe("short digest");
    expect(rec.capped).toBe(true);
  });

  test("a huge array of short strings is cut, with a marker item", async () => {
    const produced = Array.from({ length: 20_000 }, (_, i) => `shape_${i}`);
    const rec = await captured("reachGate", () => reachGateInput({ ...BASE, producedShapes: produced }));
    expect(bytes(rec)).toBeLessThanOrEqual(CAPTURE_RECORD_CAP_BYTES);
    const kept = (rec.input["evidence"] as Record<string, unknown>)["produced_shapes"] as string[];
    expect(kept.length).toBeLessThan(produced.length);
    expect(kept[kept.length - 1]).toContain(CAPTURE_TRUNCATION_MARKER);
  });

  test("a multi-byte digest is capped by BYTES, not characters", async () => {
    const rec = await captured("reachGate", () => reachGateInput({ ...BASE, digest: "é".repeat(40_000) }));
    expect(bytes(rec)).toBeLessThanOrEqual(CAPTURE_RECORD_CAP_BYTES);
  });

  test("a record under the cap is untouched and not marked", async () => {
    const rec = await captured("reachGate", () => reachGateInput({ ...BASE, digest: "a small digest" }));
    expect(rec.input["digest_excerpt"]).toBe("a small digest");
    expect(rec.capped).toBeUndefined();
    const small: Record<string, unknown> = { input: { digest_excerpt: "x" } };
    expect(capRecord(small)).toBe(false);
  });
});

describe("a dispatch's whole capture is capped at 16 KB, with a marker naming what was cut and the original size", () => {
  const dispatchBytes = (t: CaptureTarget): number => bytes({ judge_input: t.metadata!.judge_input, routing_input: t.metadata!.routing_input });

  test("the dispatch cap is 16 KB", () => { expect(CAPTURE_DISPATCH_CAP_BYTES).toBe(16 * 1024); });

  test("several records each under 32 KB but together over 16 KB: truncated, marked, the verdict unchanged", async () => {
    const target: CaptureTarget = {};
    const goal = `Write a note listing every stage of the build ${"and its owner ".repeat(400)}`;
    const rr = routingRecorder();
    attachRoutingInput(target, rr.finish(goal, goal));
    const delivered = await withCaptureTarget(target, async () => {
      const verdict = { reached: false, reason: "deterministic:fixture — decided before capture" };
      captureJudgeInput("reachGate", () => reachGateInput({ ...BASE, goal, digest: "d".repeat(12_000) }), verdict);
      captureJudgeInput("floorVerdict", () => floorVerdictInput({ ...BASE, goal, surface: "floor", digest: "e".repeat(9_000), answerText: "a".repeat(9_000), verdictReason: null, seededEvidence: false, toolsOk: 0, authoredAnswer: true }), verdict);
      captureJudgeInput("floorShortcut", () => floorShortcutInput({ goal, activities: ["universal-tool-fallback"], borrowed: false, targets: [] }), { allowed: false, why: "fixture" });
      noteRoutingHandOff({ goal, composeGapId: "route-edit-fixture", editSite: "repos/example-vessel/src/a.ts" });
      return verdict;
    });
    expect(delivered).toEqual({ reached: false, reason: "deterministic:fixture — decided before capture" });
    const ji = target.metadata!.judge_input!;
    for (const e of ["reachGate", "floorVerdict", "floorShortcut"] as const) expect(bytes(ji[e])).toBeLessThanOrEqual(CAPTURE_RECORD_CAP_BYTES);
    expect(dispatchBytes(target)).toBeLessThanOrEqual(CAPTURE_DISPATCH_CAP_BYTES);
    const m = target.metadata!.capture_truncated!;
    expect(m.cap_bytes).toBe(CAPTURE_DISPATCH_CAP_BYTES);
    expect(m.original_bytes).toBeGreaterThan(CAPTURE_DISPATCH_CAP_BYTES);
    expect(m.final_bytes).toBeLessThanOrEqual(CAPTURE_DISPATCH_CAP_BYTES);
    expect(m.truncated).toContain("judge_input.reachGate.input.digest_excerpt");
    expect(m.truncated.some((p) => p.endsWith(".answer_text") || p.endsWith(".goal") || p.endsWith(".digest_excerpt"))).toBe(true);
    for (const p of m.truncated) expect(p).not.toMatch(/\.(schema|entry)$/);
    expect(ji.reachGate!.input["digest_excerpt"] as string).toContain(CAPTURE_TRUNCATION_MARKER);
    // the recorded verdicts and the record keys are intact
    expect(ji.reachGate!.verdict).toEqual({ reached: false, reason: "deterministic:fixture — decided before capture" });
    for (const e of ["reachGate", "floorVerdict", "floorShortcut"] as const) { expect(ji[e]!.schema).toBe(1); expect(ji[e]!.entry).toBe(e); }
    expect(target.metadata!.routing_input!.schema).toBe(1);
    expect(target.metadata!.routing_input!.entry).toBe("editIntent");
    expect(target.metadata!.routing_input!.routed_to).toBe("feature_compose");
  });

  test("a dispatch under 16 KB is untouched and carries no marker", async () => {
    const target: CaptureTarget = {};
    await withCaptureTarget(target, async () => { captureJudgeInput("reachGate", () => reachGateInput({ ...BASE, digest: "small" }), { reached: true }); });
    expect(target.metadata!.capture_truncated).toBeUndefined();
    expect(target.metadata!.judge_input!.reachGate!.input["digest_excerpt"]).toBe("small");
  });
});
