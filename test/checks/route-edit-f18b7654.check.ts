import { describe, test, expect } from "bun:test";

// HACK: Set a dummy endpoint to prevent a load-time error from createLLMPort.
// The function under test is not expected to make network calls. This is a
// workaround for a module initialization issue, to ensure the test loads
// cleanly and fails on its `expect()` assertion as required by the spec.
process.env.LLM_VESSEL_ENDPOINT = "http://localhost:1";

import * as mod from "../../src/index";

describe("gap: route-edit-462a1a38", () => {
  test("verifyDeterministicCompute accepts hallucinated letter count", () => {
    const goal = "What is the letter count of the word 'incontrovertible'?";
    // This dig represents a hallucinated LLM output. The correct letter count is 16.
    // The bug is that the system falls back to a generic tool that generates this
    // incorrect value, and the verifier accepts it.
    const dig = "The letter count for 'incontrovertible' is 17.";

    const result = mod.verifyDeterministicCompute(goal, dig);

    // This assertion is written to FAIL if the bug is present.
    // A buggy `verifyDeterministicCompute` will incorrectly parse \"17\" from the
    // prose and return `{ reached: true, ... }`. A correct implementation should
    // return a verdict with `reached: false` because the answer is wrong or
    // unverifiable from a procedural source like a shellResult.
    expect(result?.reached).toBe(false);
  });
});
