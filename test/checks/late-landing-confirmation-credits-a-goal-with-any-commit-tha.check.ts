/**
 * Regression check for late-landing confirmation: it must not credit a goal as reached
 * merely because some later commit is the named file's latest change. The input includes
 * the evidence token "feature_compose" to drive the same route as the defect's path.
 *
 * After the fix:
 * - #16 goal with a7f3545 → not reached (tests still fail on activity-api 4c646963, 25 fail)
 * - Control (unrelated behaviour) stays the same.
 *
 * No network, no timers.
 */

import { describe, test, expect } from "bun:test";
import * as mod from "../../src/index";

// Failing test: asserts the DESIRED outcome at the module's own observable.
describe("late-landing confirmation graded by latest-change only (feature_compose route)", () => {
  test("#16 goal with a7f3545 is NOT reached (tests still fail)", () => {
    // The goal text names the feature_compose route and the specific commit a7f3545.
    const goal = "Goal #16 — feature_compose confirmation: activity-api 4c646963 still has 25 failures; commit a7f3545 touched the file";
    // verifyDeterministicCompute is exported by src/index.ts; it yields a GoalReachVerdict | null.
    const verdict = mod.verifyDeterministicCompute(goal, "a7f3545");
    expect(verdict && typeof verdict === "object").toBe(true);
    // Desired, post-fix behaviour: the goal is NOT reached because the failing tests still fail.
    expect((verdict as any).reached).toBe(false);
  });

  // Control: an input and observable the defect does not touch; must pass now and after the fix.
  test("CONTROL: chargeChainCarrier returns durable/composite arrays", () => {
    const out = mod.chargeChainCarrier("dispatch-xyz", ["e1", "e2"], ["d1", "d2"], true, false);
    expect(Array.isArray(out.durable)).toBe(true);
    expect(Array.isArray(out.composite)).toBe(true);
  });
});
