// goalDemandsCitation (goal-target-inference.ts) — the one hand-written pattern OP-1 added: does the goal TEXT ask for
// citations? Only then is an uncited code-investigation answer a deterministic miss (index.ts citation oracle);
// otherwise the missing citation is a soft, non-deterministic not-reached. Kept beside isCodeInvestigationGoal so the
// oracle's scope lives with the routing predicate it extends.
import { describe, expect, test } from "bun:test";
import { citationOracleApplicability, goalDemandsCitation } from "../src/goal-target-inference";

describe("goalDemandsCitation", () => {
  test.each([
    "Find where computeX is defined in the codebase and cite the file",
    "Root-cause the retry storm; cite sources",
    "Which module creates the gap rows? Citations required.",
    "Locate where the signature is generated, citing file:line",
    "Find where the pool is configured and give line numbers",
    "where is foo defined (give the line number)",
  ])("demands: %s", (g) => { expect(goalDemandsCitation(g)).toBe(true); });

  test.each([
    "Find where computeX is defined in the codebase",
    "Investigate and decompose gap systematic-failure-universal-tool-fallback-zero",
    "Summarise the city council's latest decisions", // 'city' is not 'cite'
    "Explain the excitation of the system", // 'excitation' contains 'citation' but not as a word
    "",
  ])("does not demand: %s", (g) => { expect(goalDemandsCitation(g)).toBe(false); });

  test("demanded only matters for an applicable goal: a non-investigation goal that says 'cite' is still not applicable", () => {
    expect(citationOracleApplicability("Cite three poems about rain")).toBe("not-applicable");
    expect(citationOracleApplicability("Find where computeX is defined in the codebase and cite the file:line")).toBe("demanded");
  });
});
