import { describe, it, expect } from "bun:test";
// Reproduce: [narrowed from route-edit-81b0ec2a] gap-artifact-expectation-violated-cycle-demo-3
// The observation loop verified lettercount(resilient) = 9, but a mechanism later degraded the
// artifact to a sentence claiming 10 letters. This test asserts the correct value (9) via a
// deterministic, exported entrypoint; its expect() must fail because of the live defect.
//
// Control: a second deterministic input that the defect does not touch must still behave unchanged.

// Ensure the module loads without trying to construct external clients during import
process.env.LLM_VESSEL_ENDPOINT ??= "http://127.0.0.1:8220";
process.env.ROUTE_EDIT_INTENT_TO_COMPOSE ??= "0";

// Import the module containing the verification entrypoint only inside tests (avoids load-time errors)
async function loadMod() {
  return await import("../../src/index");
}

describe("deterministic compute verification around lettercount", () => {
  it("MUST-FAIL: verifyDeterministicCompute(lettercount(resilient)) should reach with expected 9", async () => {
    // Expected/correct value in title: 9
    const mod = await loadMod();
    const verdict = await mod.verifyDeterministicCompute("lettercount(resilient)", "9");
    // Assertion fails today because the defect produces a value inconsistent with 9.
    expect(verdict?.reached).toBe(true);
  });

  it("CONTROL: verifyDeterministicCompute(lettercount(a)) reaches with expected 1", async () => {
    const mod = await loadMod();
    const control = await mod.verifyDeterministicCompute("lettercount(a)", "1");
    expect(control?.reached).toBe(true);
  });
});
