import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

// This check targets the defect: the universal tool fallback GENERATES a value instead of
// executing the exact procedure. Evidence of wrong outputs includes lettercount 17 for
// "incontrovertible" (true value is 16). Reach the implementation through an export that
// performs deterministic compute without involving the LLM port.

describe("deterministic compute executes the exact procedure", () => {
  it("lettercount('incontrovertible') should be 16 — executes shellResult, not generated", () => {
    // Expectation: the system executes the exact procedure for lettercount and returns a
    // verdict that it REACHED the goal when given the correct value (16).
    const verdict = mod.verifyDeterministicCompute("lettercount incontrovertible", "16");
    expect(verdict?.reached).toBe(true);
  });

  it("CONTROL: lettercount('a') yields 1 (a trivial case unaffected by the defect)", () => {
    const verdict = mod.verifyDeterministicCompute("lettercount a", "1");
    expect(verdict?.reached).toBe(true);
  });
});
