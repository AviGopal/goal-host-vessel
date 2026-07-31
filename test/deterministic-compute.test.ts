// Deterministic reach-verifier tests (hollow-green value-blindness closure).
// verifyDeterministicCompute independently RECOMPUTES a mechanically-verifiable answer
// (hash / fibonacci / factorial / self-contained arithmetic) and can ONLY reject a
// provably-wrong DISTINCTIVE answer — it NEVER greens. Every abstention path fails OPEN
// (returns null => the LLM judge still runs). These tests pin that contract, especially
// the Residual-4 arithmetic block, so a drafter edit that over-rejects (false-red) or
// under-rejects (re-opens the hollow-green hole) is caught by construction.
//
// IMPORT NOTE: src/index.ts guards its HTTP boot behind import.meta.main, so a dynamic
// import evaluates the module without binding a port or registering with discovery.
import { describe, it, expect, beforeAll } from "bun:test";

let verifyDeterministicCompute: (goal: string, dig: string) => { reached: boolean; reason?: string } | null;
let dcNumericCandidates: (dig: string, minDigits: number) => string[];

beforeAll(async () => {
  // src/index.ts constructs an LLM port at module load; give it a dummy endpoint so the
  // import evaluates without a live LLM (mirrors reach-routes-golden.test.ts). No port bound.
  process.env.LLM_VESSEL_ENDPOINT ??= "http://127.0.0.1:65535";
  const mod: any = await import("../src/index.ts");
  verifyDeterministicCompute = mod.verifyDeterministicCompute;
  dcNumericCandidates = mod.dcNumericCandidates;
});

describe("verifyDeterministicCompute — Residual 4: self-contained arithmetic", () => {
  it("REJECTS a wrong percentage answer when the correct one is absent", () => {
    // 37% of 48200 = 17834. Output asserts 17800 (distinctive, comparable magnitude, WRONG).
    const v = verifyDeterministicCompute("what is 37% of 48200", "The answer is 17800.");
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/wrong-compute-answer/);
  });

  it("FALLS THROUGH (null) when the correct percentage answer IS present", () => {
    const v = verifyDeterministicCompute("compute 37% of 48200", "That comes to 17834 exactly.");
    expect(v).toBeNull();
  });

  it("FALLS THROUGH when the result is not distinctive (<1000)", () => {
    // 15% of 200 = 30 — ubiquitous small number, never classify.
    const v = verifyDeterministicCompute("what is 15% of 200", "It is 31.");
    expect(v).toBeNull();
  });

  it("FALLS THROUGH when no number of the answer's form is present (cannot verify)", () => {
    const v = verifyDeterministicCompute("calculate 37% of 48200", "I could not determine a value.");
    expect(v).toBeNull();
  });

  it("ABSTAINS on a repos/ path goal (FS-aggregate family owns it)", () => {
    const v = verifyDeterministicCompute("compute 20% of 48200 lines in repos/foo-vessel/src", "9000");
    expect(v).toBeNull();
  });

  it("REJECTS a wrong product ('A times B')", () => {
    // 123 times 456 = 56088. Output asserts 56000 (wrong, comparable magnitude).
    const v = verifyDeterministicCompute("compute 123 times 456", "The product is 56000.");
    expect(v?.reached).toBe(false);
  });

  it("FALLS THROUGH for the correct product", () => {
    const v = verifyDeterministicCompute("what is 123 times 456", "123 * 456 = 56088");
    expect(v).toBeNull();
  });

  it("does NOT classify a non-compute prose goal", () => {
    const v = verifyDeterministicCompute("summarize the design of 37% of the modules", "37800 is unrelated");
    // no compute verb + no 'P% of N' distinct-integer parse => null
    expect(v).toBeNull();
  });
});

describe("verifyDeterministicCompute — regression on existing forms", () => {
  it("still rejects a wrong factorial", () => {
    // 10! = 3628800. Assert a wrong distinctive value.
    const v = verifyDeterministicCompute("compute the factorial of 10", "The factorial is 3628801.");
    expect(v?.reached).toBe(false);
  });

  it("still falls through for the correct factorial", () => {
    const v = verifyDeterministicCompute("compute 10 factorial", "10! = 3628800");
    expect(v).toBeNull();
  });

  it("still rejects a wrong fibonacci (distinctive, long)", () => {
    // fib(40) = 102334155. Assert a wrong long value.
    const v = verifyDeterministicCompute("what is the 40th fibonacci number", "It is 102334100.");
    expect(v?.reached).toBe(false);
  });
});
