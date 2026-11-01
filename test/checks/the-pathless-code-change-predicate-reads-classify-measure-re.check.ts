import { describe, it, expect } from "bun:test";
import * as mod from "../../src/goal-file-resolution";

describe("isPathlessCodeChangeGoal", () => {
  // FAILING TEST: Reproduces the defect where read-only goals are misclassified as code changes.
  // After the fix, this test must pass.
  it("should return false for read-only, classification, or measurement goals", () => {
    const readOnlyGoal =
      "Audit how a refused run is recorded. This is a read-only analysis; change no code.";
    // Fails: returns true because 'analysis' is not a disqualifier and NEGATED_SPAN misses 'change no code'.
    expect(mod.isPathlessCodeChangeGoal(readOnlyGoal)).toBe(false);

    const classifyGoal =
      "classify gap fix-the-retry-backoff's own check v/test/checks/x.check.ts at base abc as green_at_parent | red_code_reachable | red_environmental | unrunnable (ownCheckBaseline)";
    // Fails: returns true because 'classify' is not a disqualifier and MUTATION_VERB matches 'fix' in the slug.
    expect(mod.isPathlessCodeChangeGoal(classifyGoal)).toBe(false);

    const measureGoal = "Measure the impact of the new caching strategy on endpoint latency.";
     // Fails: returns true because 'measure' is not a disqualifier.
    expect(mod.isPathlessCodeChangeGoal(measureGoal)).toBe(false);
  });

  // CONTROL TEST: Verifies behavior that is correct and must remain correct after the fix.
  // This test passes now.
  it("should correctly handle genuine edits and goals that already specify a path", () => {
    const genuineEditGoal =
      "make the retry backoff in the trace retention service exponential";
    // This is a real edit request and should return true.
    expect(mod.isPathlessCodeChangeGoal(genuineEditGoal)).toBe(true);

    const goalWithFilePath =
      "fix the bug in repos/goal-host-vessel/src/goal-file-resolution.ts";
    // This has a path and should return false.
    expect(mod.isPathlessCodeChangeGoal(goalWithFilePath)).toBe(false);
  });
});
