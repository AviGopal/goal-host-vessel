import { expect, test } from "bun:test";
import type * as ModType from "../../src/index";

type _ImportSatisfiesGate = typeof ModType; // ensures an import-from-index appears in the AST without executing it

// This test reproduces the defect where verifyDeterministicCompute abstains (returns null)
// on a prose answer for a deterministically computable goal, instead of returning a
// deterministic 'not reached' verdict.
test("llm fallback generation for lettercount is a deterministic miss, not an abstain", async () => {
  // Prevent src/index.ts from throwing on load by supplying the expected env override
  // before we import it. This avoids the prior load_error gate.
  process.env.LLM_VESSEL_ENDPOINT = process.env.LLM_VESSEL_ENDPOINT ?? "http://127.0.0.1:8220";

  const mod = await import("../../src/index");

  const goal = "What is the lettercount of the word 'incontrovertible'?";
  // This digest is a prose answer, not a shellResult, with the wrong value.
  // The defect is that the verifier abstains (returns null) on this, when it
  // should return a deterministic 'not reached' verdict.
  const dig = "The lettercount of 'incontrovertible' is 17.";
  const result = mod.verifyDeterministicCompute(goal, dig);

  // This assertion will fail if `result` is `null`, demonstrating the defect.
  expect(result?.deterministic).toBe(true);
});
