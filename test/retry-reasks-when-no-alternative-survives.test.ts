// A REPEATED FAILING GOAL CAN CHANGE COURSE (gap: a repeated failing goal is offered the same single target set forever).
// The exclusion list was always empty: targetsToAvoid stopped at the newest record, which the floor had wrapped
// ("floor floor:upstream-not-reached: deterministic:write-goal-no-artifact — …") and the anchored rule did not match.
// When it did exclude, the routes had mostly proposed ONE set with no alternatives, so the exclusion kept it; and the
// routes' memo, never invalidated, proposed the same set on every later dispatch.
//
//   [MUST-FAIL] a floor-wrapped no-artifact record continues the run: the targets are avoided (today []).
//   [MUST-FAIL] no alternative survives the exclusion: the routes are re-asked once (memo bypassed, told not to propose
//               the excluded set) and what they propose is chosen; the decision carries its selection record.
//   [MUST-FAIL] a content failure invalidates the routes' memo; a timeout or an HTTP 5xx does not.
//   [CONTROL]   a newer unrelated record still ends the run; no failure -> one ask; GUARD: a gap investigation's only
//               oracle-graded target (gapDecomposition) is kept and the routes are not re-asked.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as GTI from "../src/goal-target-inference";
import * as FT from "../src/failed-targets";
const F = FT as Record<string, any>;
const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

const KNOWN = ["gitCommitResult", "gitStatusResult", "shellResult", "webSearchResult"];
const GOAL = "Show the git status of the super-repo clone";
const NA = "deterministic:write-goal-no-artifact — no artifact on the target";
const FLOOR_NA = `floor floor:upstream-not-reached: ${NA}`;
const failRows = (shapes: string[], f: number) => [{ expected_output_shapes: shapes, successful_executions: 0, failed_executions: f }];

function stub(answers: string[]) {
  const prompts: string[] = [];
  return { prompts, complete: async (p: string) => { prompts.push(p); return answers[Math.min(prompts.length - 1, answers.length - 1)]!; } };
}

describe("a repeated failing goal can change course", () => {
  it("[MUST-FAIL] T1: a floor-wrapped no-artifact record after a bare one avoids the target", () => {
    expect(F.targetsToAvoid([
      { at: "2026-10-17T10:00:00Z", reason: NA, targets: ["gitCommitResult"] },
      { at: "2026-10-17T10:05:00Z", reason: FLOOR_NA },
    ])).toEqual(["gitCommitResult"]);
  });

  it("[CONTROL] T1: a newer unrelated record still ends the run; the wrapper is anchored", () => {
    expect(F.targetsToAvoid([
      { at: "2026-10-17T10:00:00Z", reason: NA, targets: ["gitCommitResult"] },
      { at: "2026-10-17T10:05:00Z", reason: "The output did not report the status", targets: ["gitCommitResult"] },
    ])).toEqual([]);
    expect(F.targetsToAvoid([{ at: "2026-10-17T10:00:00Z", reason: `note: ${FLOOR_NA}`, targets: ["gitCommitResult"] }])).toEqual([]);
  });

  it("[MUST-FAIL] T2: no surviving alternative -> the routes are re-asked once and their new set is chosen", async () => {
    const llm = stub([
      JSON.stringify({ target_shapes: ["gitCommitResult"], alternatives: [] }),
      JSON.stringify({ target_shapes: ["gitStatusResult"], alternatives: [] }),
    ]);
    const d = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { complete: llm.complete, excludeTargets: ["gitCommitResult"], failureRows: failRows(["gitCommitResult"], 2) } as never);
    expect(llm.prompts.length).toBe(2);
    expect(llm.prompts[1]).toContain("DO NOT PROPOSE");
    expect(llm.prompts[1]).toContain("gitCommitResult");
    expect(d.shapes).toEqual(["gitStatusResult"]);
    const ts = (d as { target_selection?: { candidates: Array<{ shapes: string[]; s: number; f: number }>; chosen: string[]; excluded: string[]; reasked: boolean } }).target_selection;
    expect(ts?.reasked).toBe(true);
    expect(ts?.chosen).toEqual(["gitStatusResult"]);
    expect(ts?.excluded).toEqual(["gitCommitResult"]);
    expect(ts?.candidates).toContainEqual({ shapes: ["gitCommitResult"], s: 0, f: 2 });
    expect(ts?.candidates.map((c) => c.shapes)).toContainEqual(["gitStatusResult"]);
  });

  it("[MUST-FAIL] T2: the re-ask bypasses a memo that still holds the single stale set", async () => {
    const memo = new Map<string, GTI.GoalTargetDecision>([[GTI.goalHashOf(GOAL), { shapes: ["gitCommitResult"], confidence: 0.6, alternatives: [] }]]);
    const llm = stub([JSON.stringify({ target_shapes: ["gitStatusResult"], alternatives: [] })]);
    const d = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { complete: llm.complete, decisionCache: memo, excludeTargets: ["gitCommitResult"], failureRows: failRows(["gitCommitResult"], 1) } as never);
    expect(llm.prompts.length).toBe(1);
    expect(d.shapes).toEqual(["gitStatusResult"]);
    expect(memo.get(GTI.goalHashOf(GOAL))?.shapes).toEqual(["gitCommitResult"]); // the re-ask's answer is not memoised
  });

  it("[CONTROL A] T2: no failure -> the routes are asked once and the decision is today's", async () => {
    const llm = stub([JSON.stringify({ target_shapes: ["gitCommitResult"], alternatives: [] }), JSON.stringify({ target_shapes: ["gitStatusResult"] })]);
    const d = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { complete: llm.complete } as never);
    expect(llm.prompts.length).toBe(1);
    expect(d.shapes).toEqual(["gitCommitResult"]);
  });

  it("[CONTROL B / GUARD] T2: a gap investigation's only oracle-graded target is kept and the routes are not re-asked", async () => {
    const llm = stub([JSON.stringify({ target_shapes: ["shellResult"] })]);
    const gapGoal = "Investigate and decompose gap a-repeated-failing-goal-is-offered-the-same-target";
    const d = await GTI.inferGoalTargetDecision(gapGoal, [...KNOWN, "gapDecomposition"], { complete: llm.complete, excludeTargets: ["gapDecomposition"], failureRows: failRows(["gapDecomposition"], 3) } as never);
    expect(d.shapes).toEqual(["gapDecomposition"]);
    expect(llm.prompts.length).toBe(0);
  });

  it("[MUST-FAIL] T3: a content failure invalidates the routes' memo; a timeout or an HTTP 5xx does not", () => {
    expect(typeof F["failureInvalidatesTargetMemo"]).toBe("function");
    expect(F.failureInvalidatesTargetMemo(NA)).toBe(true);
    expect(F.failureInvalidatesTargetMemo(FLOOR_NA)).toBe(true);
    expect(F.failureInvalidatesTargetMemo("llm: the answer does not report the status")).toBe(true);
    expect(F.failureInvalidatesTargetMemo("resolve timed out after 60000ms")).toBe(false);
    expect(F.failureInvalidatesTargetMemo("shellResult resolve failed: HTTP 503")).toBe(false);
    expect(F.failureInvalidatesTargetMemo("HTTP 500 from llm-vessel")).toBe(false);
    expect(F.failureInvalidatesTargetMemo("abstain: nothing graded")).toBe(false);
    expect(F.failureInvalidatesTargetMemo("")).toBe(false);
  });

  it("[WIRING] index.ts: the memory filter is the shared rule, a content failure clears the memo, the record carries the selection", () => {
    expect(SRC).toContain("if (/^abstain:/i.test(r) || !failureInvalidatesTargetMemo(r)) return;");
    expect(SRC).toContain("inferredTargetRoutesMemo.delete(rec.hash);");
    expect(SRC).toContain("inferredTargetShapeCache.delete(rec.hash);");
    expect(SRC).toContain("record.targetSelection = typeof goal === \"string\" ? (inferredTargetDecisionCache.get(goalHashOf(goal))?.target_selection ?? null) : null;");
    expect(SRC).toContain("targetSelection: record.targetSelection ?? null,");
  });
});
