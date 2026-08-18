import { describe, it, expect } from "bun:test";

/**
 * THE SYSTEM REFUSED TO LEARN FROM EVIDENCE IT WENT ON MINTING FROM.
 *
 * Audit finding 3.7, verified in the tree. The α gate had already dropped the
 * `commandEvidence` anchor, on measurement recorded in its own comment:
 *
 *   80 goals, four classes with no deterministic verifier (subdirectory counts, distinct
 *   file extensions, largest-module-by-lines, grep counts). 72/80 graded REACHED and only
 *   23/80 were CORRECT — 68% of reaches were hollow. ext_variety: 20/20 reached, 0/20
 *   correct. EVERY one of those false reaches had run a command, because shelling out is
 *   how that family produces its wrong number.
 *
 * `isGroundedHonestReach` — which gates MINTING — still returned true on that same bare
 * anchor. So evidence proven 68% hollow was rejected for updating a posterior and accepted
 * for creating permanent structure.
 *
 * That is the worse direction of the two. Crediting a hollow reach corrupts one posterior
 * and can be out-learned; minting from one adds a cell that must then be out-learned, splits
 * selection traffic, and persists. Law 3 states it directly — "A wrong mint is negative
 * value, not zero" — and DYNAMICS §3 gives the same thing as an inequality: minting on
 * evidence too weak to raise λ₁ raises ρ_grow, and λ₁ ≳ ρ_grow is the condition for the
 * system to keep tracking at all.
 *
 * THE INVARIANT THIS PINS is agreement, not any particular rule: two gates reading the same
 * evidence to opposite conclusions is how a rejected reach still leaves structure behind. If
 * the credit gate's admissible anchors change, this must change with them.
 */

const SRC = new URL("../src/index.ts", import.meta.url);

async function source(): Promise<string> {
  return await Bun.file(SRC).text();
}

async function mintGate(): Promise<string> {
  const src = await source();
  const i = src.indexOf("function isGroundedHonestReach");
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, i + 3000);
}

async function creditGate(): Promise<string> {
  const src = await source();
  // ANCHOR ON CODE, NOT ON PROSE. The first draft located this block by the phrase
  // "A COMMAND HAVING RUN IS NOT EVIDENCE" — and then the mint-gate fix QUOTED that phrase
  // in its own explanatory comment, so indexOf started returning the mint gate and two
  // assertions failed against the wrong block. The anchor was unique when written and stopped
  // being unique because of the change it was written to describe.
  //
  // "A unique anchor must also be the BINDING site." The credit gate's own condition appears
  // exactly once and cannot be quoted elsewhere without becoming real code.
  const i = src.indexOf("if (verdict.deterministic === true || (!editEffectReach && consumedInChain.size > 0)) {");
  expect(i).toBeGreaterThan(-1);
  // Window backwards too: the measurement lives in the comment ABOVE the condition.
  return src.slice(Math.max(0, i - 2500), i + 400);
}

describe("mint gate agrees with credit gate on what counts as substance", () => {
  it("guards the instrument: both gates are findable and distinct", async () => {
    const m = await mintGate();
    const c = await creditGate();
    expect(m).toContain("isGroundedHonestReach");
    // NOT "68% of reaches were hollow": in the source that phrase is wrapped across a line
    // break ("**68% of reaches were\n// hollow**"), so it never matches as a contiguous
    // string. The first draft asserted the sentence a human reads rather than the bytes the
    // file contains — a rendered-text assertion against raw source.
    expect(c).toContain("23/80 were correct");
    expect(m).not.toBe(c);
  });

  it("THE REGRESSION: bare commandEvidence no longer admits a mint", async () => {
    const m = await mintGate();
    // Was: `if ((ev.commandEvidence ?? "").trim().length > 0) return true;`
    expect(m).not.toMatch(/if \(\(ev\.commandEvidence[^\n]*\)\s*return true;/);
  });

  it("the two substantive anchors survive in BOTH gates", async () => {
    const m = await mintGate();
    const c = await creditGate();
    // deterministic verdict
    expect(m).toMatch(/v\.deterministic === true/);
    expect(c).toMatch(/verdict\.deterministic === true/);
    // genuine in-chain edge, with the edit-effect exclusion
    expect(m).toMatch(/consumedInChain[^\n]*&& !ev\.editEffectReach/);
    expect(c).toMatch(/!editEffectReach && consumedInChain\.size > 0/);
  });

  it("commandEvidence is NOT deleted — it still feeds the judge", async () => {
    // The anchor was never worthless, it was insufficient. It still goes into the reach
    // judge's prompt so the judge can grade command-vs-intent alignment. Removing it there
    // would trade a false-mint problem for a blinder judge, which this repo has already
    // measured as the more expensive failure.
    const src = await source();
    expect(src).toContain("COMMANDS THAT PRODUCED THE OUTPUT");
    expect(src).toMatch(/commandEvidence\?: string/);
  });

  it("NEGATIVE CONTROL: the gate can still return true", async () => {
    // A gate that rejects everything would pass every assertion above while silently
    // stopping all minting — a worse outcome than the defect, and invisible without this.
    const m = await mintGate();
    const returnsTrue = (m.match(/return true;/g) ?? []).length;
    expect(returnsTrue).toBeGreaterThanOrEqual(2);
  });

  it("the measured basis stays attached to the decision", async () => {
    // The numbers are what make this defensible against "the gate is too strict". A future
    // reader who wants to re-add the anchor needs to see what it cost, not just that it was
    // removed.
    const m = await mintGate();
    expect(m).toMatch(/72\/80|68%/);
  });
});
