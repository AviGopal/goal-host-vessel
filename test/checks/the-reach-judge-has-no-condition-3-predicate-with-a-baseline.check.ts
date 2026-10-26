import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

/**
 * The defect: The LLM reach judge, implemented in `verifyGoalReached`, lacks
 * logic for conditions 3 and 4 as defined in REALIGNMENT.md.
 * C3: 'right predicate with a baseline tied to this action'
 * C4: 'independent verifier or abstain'
 * This test file provides one failing test that reproduces the defect for
 * both conditions, and one passing control test that verifies existing correct behavior.
 */
describe("LLM reach judge", () => {
  // This is the single failing test case required by the spec.
  // It demonstrates that the current implementation fails to correctly judge
  // goals based on baselines (C3) and self-reported evidence (C4).
  it("is missing condition 3 (baseline check) and 4 (independent verifier)", async () => {
    // Test for missing Condition 3: 'right predicate with a baseline tied to this action'
    // A goal with an unmet quantitative baseline.
    const c3Goal = "Increase test coverage to at least 90%.";
    const c3Verdict = await mod.verifyGoalReached(
      c3Goal,
      ["coverageReport"],
      "Ran tests. New coverage is 85%.",
      undefined,
      "command evidence: coverage is 85%"
    );

    // DEFECT: currently, this likely returns `{ reached: true }` because a number was
    // produced and the summary sounds positive. The judge doesn't parse the baseline.
    // EXPECTED: should return `{ reached: false }` because 85% < 90%.
    expect(c3Verdict).not.toBeNull(); // It should be decisive, not abstain due to confusion.
    expect(c3Verdict?.reached).toBe(false); // The core of the C3 defect.

    // Test for missing Condition 4: 'independent verifier or abstain'
    // A goal satisfied only by a self-report without external evidence.
    const c4Goal = "The service deployment was successful.";
    const c4Verdict = await mod.verifyGoalReached(
      c4Goal,
      [],
      "I deployed the service, it was successful.", // Self-report without evidence
      undefined,
      undefined
    );

    // DEFECT: currently, this likely returns `{ reached: true }` based on the claim.
    // EXPECTED: should abstain because the claim is not independently verifiable from evidence.
    expect(c4Verdict).not.toBeNull();
    expect(c4Verdict?.abstain).toBeDefined(); // The core of the C4 defect.
    expect(c4Verdict?.reached).toBe(false); // An abstained verdict is not a reached verdict.
  });

  // This is the control test case. It should pass before and after the fix.
  // It shows that currently working cases (met baseline, grounded evidence)
  // are not broken.
  it("has correct behavior for met baselines and grounded evidence (CONTROL)", async () => {
    // Control for C3: a met baseline should be 'reached'.
    const c3ControlGoal = "Increase test coverage to at least 90%.";
    const c3ControlVerdict = await mod.verifyGoalReached(
      c3ControlGoal,
      ["coverageReport"],
      "Ran tests. New coverage is 92%.",
      undefined,
      "command evidence: coverage is 92%"
    );

    // This should pass now (heuristically) and after the fix (correctly).
    expect(c3ControlVerdict).not.toBeNull();
    expect(c3ControlVerdict?.reached).toBe(true);

    // Control for C4: a goal with strong, independent evidence should be reached.
    // This leverages existing Condition 1 (grounded) logic.
    const c4ControlGoal = "The content of 'status.txt' is 'OK'.";
    const c4ControlVerdict = await mod.verifyGoalReached(
      c4ControlGoal,
      ["fileReadResult"],
      "Read from status.txt.",
      "fake-digest-for-content-OK",
      "Command `cat status.txt` output: OK" // Strong evidence
    );
    expect(c4ControlVerdict).not.toBeNull();
    expect(c4ControlVerdict?.abstain).toBeUndefined(); // Should be confident, not abstain.
    expect(c4ControlVerdict?.reached).toBe(true);
  });
});
