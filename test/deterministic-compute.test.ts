// Deterministic reach-verifier tests (hollow-green value-blindness closure).
// verifyDeterministicCompute independently RECOMPUTES a mechanically-verifiable answer
// (hash / fibonacci / factorial / self-contained arithmetic). Contract (revised — the
// measured false rejection on dispatch e5a1849a: a correct standalone shellResult
// stdout "20413" was handed to the LLM judge, which re-derived the arithmetic wrongly
// and rejected it):
//   - a provably-wrong DISTINCTIVE answer => reject (unchanged);
//   - the recomputed truth DELIVERED STANDALONE (exact trimmed shellResult stdout, or a
//     digest line that IS the bare value) AND the goal names no artifact write
//     => deterministic GREEN (verified-compute-answer);
//   - truth merely PRESENT but buried in prose/blobs, or the goal asks to
//     write/save/store/record/append/titled => null (LLM judge still owns delivery).
// Every other abstention path still fails OPEN (returns null => the LLM judge runs).
// These tests pin that contract, especially the Residual-4 arithmetic block, so a
// drafter edit that over-greens (buried truth), over-rejects (false-red) or
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

describe("verifyDeterministicCompute — standalone-delivery deterministic GREEN (e5a1849a closure)", () => {
  const ARITH_GOAL = "Compute 137 * 149. Return only the decimal integer, with no Markdown, explanation, or other text.";

  it("GREENS a correct answer delivered as the entire trimmed shellResult stdout", () => {
    const dig = '- shellResult: {"shape":"shellResult","stdout":"20413\\n","stderr":"","exit_code":0}';
    const v = verifyDeterministicCompute(ARITH_GOAL, dig);
    expect(v?.reached).toBe(true);
    expect((v as { deterministic?: boolean } | null)?.deterministic).toBe(true);
    expect(v?.reason).toMatch(/verified-compute-answer/);
  });

  it("GREENS a bare digest line that IS the value", () => {
    const v = verifyDeterministicCompute("what is 123 times 456", "56088");
    expect(v?.reached).toBe(true);
  });

  it("stays NULL when the truth is buried in a web-search blob (attempt-2 shape must NOT green)", () => {
    const dig = '- webSearchResult: {"shape":"webSearchResult","query":"137 * 149","results":[{"title":"149 multiplied by 137 equals 20413","url":"https://example.net/","snippet":"149 multiplied by 137 equals 20413"}]}';
    expect(verifyDeterministicCompute(ARITH_GOAL, dig)).toBeNull();
  });

  it("stays NULL when the truth is present only inside prose", () => {
    expect(verifyDeterministicCompute("compute 37% of 48200", "That comes to 17834 exactly.")).toBeNull();
  });

  it("stays NULL on standalone truth when the goal names an artifact write", () => {
    const v = verifyDeterministicCompute('compute 123 times 456 and save it in a memory note titled "products"', "56088");
    expect(v).toBeNull();
  });

  it("GREENS a standalone fibonacci stdout", () => {
    const dig = '- shellResult: {"shape":"shellResult","stdout":"102334155\\n","stderr":"","exit_code":0}';
    const v = verifyDeterministicCompute("what is the 40th fibonacci number", dig);
    expect(v?.reached).toBe(true);
  });

  it("still REJECTS a wrong standalone stdout (green path must not weaken rejection)", () => {
    const dig = '- shellResult: {"shape":"shellResult","stdout":"20412\\n","stderr":"","exit_code":0}';
    const v = verifyDeterministicCompute(ARITH_GOAL, dig);
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/wrong-compute-answer/);
  });
});
