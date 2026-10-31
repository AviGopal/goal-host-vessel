// TWO INSTRUMENT LINES THAT COULD NOT TELL THE TRUTH (instrumentation only; no decision changes).
//
// 1. tryLexicalRebind's "[rebind] outcome" line was emitted BEFORE the donor loop, so every call logged
//    candidates=0 whatever the loop then found. It belongs after the loop, beside the refusal tallies.
// 2. The pick tier 0a's "MINTED-COVER <id> not in the feasible set" line could not tell a cover that was ABSENT from
//    this step's candidates from one that was present and REJECTED by a feasibleProducer check. It now names which.
//
//   [MUST-FAIL] the "[rebind] outcome" line comes after the donor loop, and none comes before it
//   [MUST-FAIL] the not-feasible MINTED-COVER line names its reason: absent, or the check that rejected it
//   [CONTROL]   the 0a decision text is unchanged (the same find over feasibleProducer), and the result line stays after the loop
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
const fnStart = SRC.indexOf("function tryLexicalRebind(");
const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
const REBIND = fnStart >= 0 && fnEnd > fnStart ? SRC.slice(fnStart, fnEnd) : "";
const LOOP = "for (const [srcHash, e] of reachedCommandCache.entries())";

describe("instrument lines tell the truth", () => {
  it('[MUST-FAIL] the "[rebind] outcome" line comes after the donor loop, and none comes before it', () => {
    const loop = REBIND.indexOf(LOOP);
    expect(loop).toBeGreaterThan(0);
    const before = REBIND.slice(0, loop);
    const after = REBIND.slice(loop);
    expect(before.includes("[rebind] outcome")).toBe(false);
    expect(after.includes('console.log("[rebind] outcome selected=" + (best ? "yes" : "no") + " candidates=" + candidates);')).toBe(true);
    // it reports before the no-adaptation branch, so the refusal tallies of the same call follow it
    expect(after.indexOf("[rebind] outcome")).toBeLessThan(after.indexOf("if (!best) {"));
  });

  it("[MUST-FAIL] the not-feasible MINTED-COVER line names its reason: absent, or the check that rejected it", () => {
    const at = SRC.indexOf("not in the feasible set");
    expect(at).toBeGreaterThan(0);
    const line = SRC.slice(SRC.lastIndexOf("\n", at), SRC.indexOf("\n", at));
    expect(line).toContain("MINTED-COVER ${_mcId} not in the feasible set");
    expect(line).toContain("absent from candidates");
    expect(line).toContain("rejected by ");
    const block = SRC.slice(SRC.indexOf("const _mcSeen = candidates.filter("), at);
    for (const check of ["notScaffold(c)", "isIrrelevantLearnedComposite(c)", "proven-bad posterior", "advancesTarget(c)", "inputs unbound"]) {
      expect(block).toContain(check);
    }
  });

  it("[CONTROL] the 0a decision text is unchanged, and the result line stays after the loop", () => {
    expect(SRC.includes("const mintedPick = candidates.find((c) => normActivityId(c.id) === _mcId && feasibleProducer(c));")).toBe(true);
    expect(SRC.includes("notScaffold(c) && !isIrrelevantLearnedComposite(c) && advancesTarget(c) && (c.inputShapes.length === 0 || c.inputShapes.every((s) => producedShapes.has(s)));")).toBe(true);
    expect(REBIND.indexOf("[rebind] result for")).toBeGreaterThan(REBIND.indexOf(LOOP));
  });
});
