import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

// This check targets the lettercount verification logic in src/index.ts.
// It reproduces the observed degradation where the system now claims
// "The word resilient has 10 letters" instead of the correct 9.
// We assert the correct behaviour (reached === true for 9), which should FAIL
// under the current defect, while loading cleanly with no network/env dependencies.

describe("route-edit-067b2f00-narrowed: lettercount('resilient')", () => {
  it("verifies that 'resilient' has 9 letters (expected true)", () => {
    const goal = "The word resilient has 9 letters";
    // The second argument is a digest/id; using the cited artifact key ties to the report.
    const verdict = mod.verifyDeterministicCompute(goal, "cycle-demo-3");
    // Under correct logic this would be true; current defect miscounts to 10, making this fail.
    expect(verdict?.reached).toBe(true);
  });
});
