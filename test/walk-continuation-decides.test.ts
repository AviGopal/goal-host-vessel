// THE WALK'S CONTINUATION IS ONE DECISION, AND ITS NO-PROGRESS LIMIT IS THE WALK BUDGET'S (REALIGNMENT §7 step 1;
// wiring item W2). decideContinuation (walk-continuation.ts) was imported and never called. The walk ran two inline
// copies of "2 consecutive no-progress steps — stopping" (the literal 2), and the single-pick step's target test
// `continue`d ABOVE its copy: a targeted walk whose steps added nothing to the pool never counted one, so it ran to
// MAX_STEPS instead of stopping.
//
//   [MUST-FAIL] index.ts calls decideContinuation at both step sites; no inline copy or literal 2 is left.
//   [MUST-FAIL] the limit is read from the walk budget (`max_no_progress_steps`, recorded default 2).
//   [MUST-FAIL] the single-pick decision runs BEFORE the target test, so a targeted walk counts its steps.
//   [BEHAVIOUR] the decision the walk now makes: a targeted walk adding nothing new stops at step 2 (the default limit),
//               or at the budget's limit when the budget names one.
//   [CONTROL]   a walk making progress continues (the counter resets); a target shape is accepted, a non-target one is
//               not (the interim reach check runs only for the former).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { decideContinuation } from "../src/walk-continuation";

const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

/** Run the walk's per-step decision over a sequence of steps, as index.ts calls it; returns the step it stops at (1-based) or null. */
function stopsAt(steps: Array<{ progressed: boolean; targetProduced?: string }>, limit: number): number | null {
  let count = 0;
  for (let i = 0; i < steps.length; i++) {
    const p = steps[i]!.targetProduced ?? "";
    const c = decideContinuation({ producedShape: p, noProgressCount: count, terminationReason: null, satisfiesTarget: p.length > 0, madeProgress: steps[i]!.progressed, maxNoProgressSteps: limit, maxWalkSteps: Number.POSITIVE_INFINITY, stepIndex: i });
    count = c.noProgressCount;
    if (c.terminationReason) return i + 1;
  }
  return null;
}

describe("the walk's continuation is one decision", () => {
  it("[MUST-FAIL] both step sites call decideContinuation; no inline copy or literal 2 is left", () => {
    expect(SRC.split("decideContinuation({").length - 1).toBe(2);
    expect(SRC).not.toContain("consecutiveNoProgress >= 2");
    expect(SRC).not.toContain("2 consecutive no-progress steps — stopping");
    expect(SRC).not.toContain('walkTerminationReason = "no pool progress for 2 consecutive steps";');
  });

  it("[MUST-FAIL] the no-progress limit is the walk budget's, with a recorded default", () => {
    expect(SRC).toContain('const MAX_NO_PROGRESS_STEPS = await shapedBudget("max_no_progress_steps", 2, 1, 40);');
    expect(SRC.split("maxNoProgressSteps: MAX_NO_PROGRESS_STEPS").length - 1).toBe(2);
  });

  it("[MUST-FAIL] the single-pick decision runs before the target test, which only skips the interim reach check", () => {
    const start = SRC.indexOf("const progressed = producedShapes.size > beforeSize;");
    const end = SRC.indexOf("const _terminalsPending", start);
    expect(start).toBeGreaterThan(-1);
    const step = SRC.slice(start, end);
    const decide = step.indexOf("const _cont = decideContinuation({");
    const targetSkip = step.indexOf("if (target.size > 0 && !_cont.accepted) continue;");
    expect(decide).toBeGreaterThan(-1);
    expect(targetSkip).toBeGreaterThan(decide);
    expect(step.indexOf("if (_cont.terminationReason) {")).toBeLessThan(targetSkip);
    expect(step).toContain("walkTerminationReason = _cont.terminationReason;");
    expect(step).not.toContain("if (target.size > 0 && !_stepNew.some((s) => target.has(s))) continue;");
  });

  it("[BEHAVIOUR] a targeted walk adding nothing new stops at step 2, or at the budget's limit", () => {
    const stuck = [{ progressed: false }, { progressed: false }, { progressed: false }, { progressed: false }];
    expect(stopsAt(stuck, 2)).toBe(2);
    expect(stopsAt(stuck, 3)).toBe(3);
  });

  it("[CONTROL] a walk making progress continues; only a target shape is accepted", () => {
    expect(stopsAt([{ progressed: false }, { progressed: true }, { progressed: false }, { progressed: true, targetProduced: "gitStatusResult" }], 2)).toBeNull();
    expect(stopsAt([{ progressed: true }, { progressed: true }, { progressed: true }], 2)).toBeNull();
    const nonTarget = decideContinuation({ producedShape: "", noProgressCount: 0, terminationReason: null, satisfiesTarget: false, madeProgress: true, maxNoProgressSteps: 2, maxWalkSteps: Number.POSITIVE_INFINITY, stepIndex: 0 });
    expect(nonTarget.accepted).toBe(false);
    expect(nonTarget.terminationReason).toBeNull();
    const hit = decideContinuation({ producedShape: "gitStatusResult", noProgressCount: 1, terminationReason: null, satisfiesTarget: true, madeProgress: true, maxNoProgressSteps: 2, maxWalkSteps: Number.POSITIVE_INFINITY, stepIndex: 5 });
    expect(hit.accepted).toBe(true);
    expect(hit.noProgressCount).toBe(0);
    // the step ceiling is the loop's own: Infinity never terminates a progressing walk here
    expect(decideContinuation({ producedShape: "", noProgressCount: 0, terminationReason: null, satisfiesTarget: false, madeProgress: true, maxNoProgressSteps: 2, maxWalkSteps: Number.POSITIVE_INFINITY, stepIndex: 10_000 }).terminationReason).toBeNull();
  });
});
