// J3: A HOLLOW WALK RE-TRIES EVERY ALTERNATIVE FRAMING, IN THE DECISION'S ORDER, BOUNDED BY THE DISPATCH'S BUDGET.
// It used to try only the first differing alternative, once (b416bf0, 07-14).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { reframeCandidates } from "../src/reframe-candidates";

describe("J3: the reframe tries the alternatives in order", () => {
  it("[MUST-FAIL] alternatives [A, B] after the primary failed: BOTH are candidates, A then B (today only A ran)", () => {
    expect(reframeCandidates([["llm_completion_dispatch"], ["webSearchResult"]], ["shellResult"], 3)).toEqual([["llm_completion_dispatch"], ["webSearchResult"]]);
  });

  it("[CONTROL] the framing just tried, empty and malformed alternatives are skipped; order is the decision's own", () => {
    expect(reframeCandidates([["shellResult"], [], "x", ["b"], ["a"]], ["shellResult"], 5)).toEqual([["b"], ["a"]]);
  });

  it("[HELD-OUT] maxAttempts 1 tries only one alternative; a single alternative behaves as before", () => {
    expect(reframeCandidates([["a"], ["b"]], [], 1)).toEqual([["a"]]);
    expect(reframeCandidates([["a"]], [], 3)).toEqual([["a"]]);
    expect(reframeCandidates(undefined, [], 3)).toEqual([]);
  });

  it("[PARAPHRASE] the candidates depend on the decision only (no goal text is an input)", () => {
    expect(reframeCandidates.length).toBe(3);
  });

  it("[WIRING] the walk loops over every candidate through the existing acceptance and stops at the first accepted reach", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).toContain("const altCandidates: string[][] = reframeCandidates(goalTargetDecision.alternatives, currentShapes, opts.maxAttempts);");
    expect(src).toContain("for (const altShapes of altCandidates) {");
    const at = src.indexOf("for (const altShapes of altCandidates) {");
    const body = src.slice(at, at + 9000);
    expect(body).toContain("judge.reframeAccept(");
    expect(body).toMatch(/walk = altWalkResult;\s*break; \/\/ J3/);
    expect(body).toContain("return altWalkResult; // ABSTAIN");
  });
});
