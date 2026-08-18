import { describe, it, expect } from "bun:test";

/**
 * AN ARM THAT CAN LOSE BUT CANNOT WIN IS NOT BEING GRADED — IT IS BEING DRAINED.
 *
 * Audited 2026-08-17. The α gate is
 *
 *     verdict.deterministic === true || (!editEffectReach && consumedInChain.size > 0)
 *
 * and `consumedInChain` grows only when a step declares INPUT shapes that an earlier step
 * produced (`ledgerStep(inputShapes, outputs)`). All three satisfier sites call
 * `ledgerStep(undefined, [...])` — a vessel-resolve satisfier genuinely consumes nothing
 * in-chain — so a satisfier pick can never contribute an edge.
 *
 * β, meanwhile, fired on any `reached === false`, gated only by the `no-oracle-for-goal-class`
 * exemption. So for an LLM-judged verdict on a satisfier-dominated chain:
 *
 *     reached = false  ->  β applied
 *     reached = true   ->  α withheld
 *
 * The posterior can only move DOWN, at a rate set by how often the arm is SELECTED rather
 * than by how well it PERFORMS. And this is the dominant step kind, not a corner: 57/57 alpha
 * credits over 72h named a `satisfier:*` id.
 *
 * The principle was already in this file, argued for the adjacent case: "Penalising the arm
 * here would teach the learner to avoid a pathway that may have been perfectly good, which is
 * the 'a right answer punished is worse than a wrong one credited' failure." Missing-edge is
 * the same situation with a different cause. MDP §2.1 specifies the symmetric conjugate
 * update α ← α + r, β ← β + (1−r); a gate admitting only the β half is not that update.
 *
 * SCOPE: this removes an asymmetry, it does not soften grading. A deterministic verdict still
 * penalises, and so does any chain that actually formed an edge.
 */

const SRC = new URL("../src/index.ts", import.meta.url);

async function source(): Promise<string> {
  return await Bun.file(SRC).text();
}

/** The β-penalty block, located by its own guard rather than by line number. */
async function betaBlock(): Promise<string> {
  const src = await source();
  const i = src.indexOf("const _noOracle =");
  expect(i).toBeGreaterThan(-1);
  // 4500, not 3500: the first draft cut the window off three characters before the second
  // log line and reported a defect that was not there. An instrument that truncates its
  // subject reports on the truncation.
  return src.slice(i, i + 4500);
}

describe("credit gate — β is held to the same evidence standard as α", () => {
  it("guards the instrument: the β block is findable and is the right one", async () => {
    const b = await betaBlock();
    // A mislocated slice would make every assertion below pass or fail for the wrong reason.
    expect(b).toContain("penaliseHollowTemplate");
    expect(b).toContain("no-oracle-for-goal-class");
  });

  it("THE REGRESSION: β is withheld when α was structurally unreachable", async () => {
    const b = await betaBlock();
    expect(b).toMatch(/_alphaWasReachable/);
    expect(b).toMatch(/_betaWithheldForSymmetry/);
    // The predicate must mirror the α gate's two admissible grounds, or it is a new rule
    // rather than the same rule applied symmetrically.
    expect(b).toMatch(/verdict\.deterministic === true \|\|\s*consumedInChain\.size > 0/);
  });

  it("the penalty is guarded by BOTH exemptions, not just the original one", async () => {
    const b = await betaBlock();
    expect(b).toMatch(/if \(!_noOracle && !_betaWithheldForSymmetry\)/);
  });

  it("the two withholding reasons log DIFFERENTLY — they are different gaps", async () => {
    const b = await betaBlock();
    // This exact line once printed "β-penalised" unconditionally, including on a branch that
    // withheld it; the file records that as "the code was right and the log was wrong, which
    // is the worse way round". Collapsing two reasons into one message repeats it one level
    // down: a missing VERIFIER and a missing EDGE call for different repairs.
    expect(b).toMatch(/else if \(_noOracle\)/);
    expect(b).toMatch(/the gap is the missing verifier/);
    expect(b).toMatch(/missing producer→consumer edge/);
  });

  it("a DETERMINISTIC verdict still penalises — this is not a softening", async () => {
    const b = await betaBlock();
    // _alphaWasReachable is true whenever the verdict is deterministic, so the symmetry
    // exemption cannot fire there. If someone later drops that disjunct, deterministic
    // misses stop being penalised and grading really does soften.
    expect(b).toMatch(/verdict\.deterministic === true \|\|/);
  });

  it("NEGATIVE CONTROL: the predicate distinguishes reachable from unreachable", () => {
    // Prove the logic can produce both answers before trusting that it produces the right
    // one. Mirrors the source predicate exactly.
    const alphaReachable = (deterministic: boolean, consumed: number) => deterministic || consumed > 0;
    expect(alphaReachable(true, 0)).toBe(true);    // deterministic verdict — β still applies
    expect(alphaReachable(false, 2)).toBe(true);   // real edge formed — β still applies
    expect(alphaReachable(false, 0)).toBe(false);  // satisfier chain, LLM verdict — β withheld
  });

  it("satisfier steps still declare NO inputs — the premise is not quietly patched", async () => {
    const src = await source();
    // The tempting "fix" is to fake inputs on satisfier steps so they earn an edge. That
    // would manufacture composition evidence that did not happen and corrupt the very signal
    // the edge exists to carry. If these ever gain inputs it must be because they really
    // consume something, and this test should be revisited deliberately.
    const sites = [...src.matchAll(/ledgerStep\(undefined,/g)];
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });
});
