import { describe, expect, it } from "bun:test";

import { parseTwoSourceCompare } from "./two-source-parse";

const A = "repos/boredom-vessel/src";
const B = "repos/llm-resolver-vessel/src";

/**
 * Corpus-test the predicate BEFORE dispatching against it. Every wrong answer this family
 * has produced came from a phrasing this parse declined, which then fell through to the
 * single-source builder — and that builder's verifier shares its parse, so a wrong answer
 * of the right SHAPE is confirmed by construction.
 */
describe("parseTwoSourceCompare — comparisons (unchanged behaviour)", () => {
  it("parses the 'or' phrasing", () => {
    const p = parseTwoSourceCompare(`Which has more TypeScript modules, ${A} or ${B}?`);
    expect(p?.output).toBe("which_diff");
    expect(p?.dir).toBe("more");
    expect(p?.ext).toBe("ts");
  });

  it("parses the 'than' phrasing", () => {
    const p = parseTwoSourceCompare(`How many more TypeScript files are under ${A} than under ${B}?`);
    expect(p?.output).toBe("which_diff");
  });

  it("parses 'fewer' and keeps the direction", () => {
    const p = parseTwoSourceCompare(`Which has fewer TypeScript modules, ${B} or ${A}, and by how many?`);
    expect(p?.dir).toBe("fewer");
  });

  it("still DECLINES compare + combined, which one command cannot answer", () => {
    // The builder emits a single value; answering the comparison and certifying it would
    // leave the combined conjunct silently missing.
    expect(parseTwoSourceCompare(`Which has more TypeScript files, ${A} or ${B}, and what is the combined total across both?`)).toBeNull();
  });

  it("declines an ambiguous or absent comparator", () => {
    expect(parseTwoSourceCompare(`Compare ${A} or ${B}`)).toBeNull();          // neither more nor fewer
    expect(parseTwoSourceCompare(`Look at ${A} and ${B}`)).toBeNull();         // no comparative, no sum
  });

  it("needs exactly two distinct directory roots", () => {
    expect(parseTwoSourceCompare(`Which has more files, ${A} or ${A}?`)).toBeNull();
    expect(parseTwoSourceCompare(`How many files are under ${A}?`)).toBeNull();
  });
});

describe("parseTwoSourceCompare — pure combination (the new case)", () => {
  it("OBSERVED LIVE: a combined total with no comparative must parse", () => {
    // dispatch d6153937 — this declined, fell to the single-source builder, and was
    // certified "counted 6 .ts file(s) in repos/boredom-vessel/src" while the shell had
    // already produced BOTH operands ("6\n2\n"). The question asked was never answered.
    const p = parseTwoSourceCompare(`What is the combined number of TypeScript modules across ${A} and ${B}?`);
    expect(p?.output).toBe("combined");
    expect(p?.ext).toBe("ts");
    expect([p?.relA, p?.relB].sort()).toEqual([A, B].sort());
  });

  it("parses the other combination phrasings", () => {
    expect(parseTwoSourceCompare(`How many TypeScript files are in ${A} and ${B} altogether?`)?.output).toBe("combined");
    expect(parseTwoSourceCompare(`Total across both ${A} and ${B} of TypeScript files`)?.output).toBe("combined");
  });

  it("does not need a comparator, since a sum has no direction", () => {
    // The ambiguity guard rejects "neither more nor fewer" for comparisons; a sum must
    // survive it.
    const p = parseTwoSourceCompare(`What is the combined number of files across ${A} and ${B}?`);
    expect(p).not.toBeNull();
    expect(p?.output).toBe("combined");
  });

  it("counts lines when the goal says lines", () => {
    expect(parseTwoSourceCompare(`What is the combined number of lines across ${A} and ${B}?`)?.op).toBe("total_lines");
  });
});

// DEPLOYED-TREE PATHS (2026-08-17). The measured two-source SUM goal named two /vessels
// paths and did not parse here at all — this pattern accepted only `repos/`. It fell through
// to a single-source builder, and although the walk produced the correct answer (58 + 2 = 60,
// hand-verified against ground truth captured before dispatch), NO oracle could confirm it.
// The credit gate then correctly withheld alpha, because it requires a deterministic verdict
// or a real producer→consumer edge and had neither. A class with no verifier can never bank a
// verified donor, so the rung reached and taught nothing.
describe("parseTwoSourceCompare — deployed /vessels trees", () => {
  const VA = "/vessels/goal-host-vessel/src";
  const VB = "/vessels/ribosome-vessel/src";

  it("an UNSCOPED two-source sum over /vessels paths parses", () => {
    const p = parseTwoSourceCompare(
      `Count the .ts files under ${VA}, then count the .ts files under ${VB}, then report the SUM of those two counts as a single number.`,
    );
    expect(p).not.toBeNull();
    expect(p!.output).toBe("combined");
    expect(p!.op).toBe("file_count");
    expect(p!.ext).toBe("ts");
  });

  it("THE FALSE REACH: a goal scoped to \"directly inside\" must ABSTAIN", () => {
    // Measured 2026-08-17. This exact goal (true answer 58 + 2 = 60) was answered
    // 65 + 7 = 72 — counted RECURSIVELY — graded deterministic:verified-two-source-combined,
    // and ALPHA-CREDITED. TwoSrcParse has no scope field, so builder and verifier agreed by
    // construction on a question the goal did not ask. Abstaining hands it to the walk, which
    // answered it correctly.
    const p = parseTwoSourceCompare(
      `Count the .ts files directly inside ${VA}, then count the .ts files directly inside ${VB}, then report the SUM of those two counts as a single number.`,
    );
    expect(p).toBeNull();
  });

  it("every top-level scope phrasing abstains, not just the measured one", () => {
    for (const scope of ["directly inside", "directly in", "directly under", "top-level", "non-recursive", "at the root of"]) {
      expect(
        parseTwoSourceCompare(`the combined number of .ts files ${scope} ${VA} and ${scope} ${VB}`),
      ).toBeNull();
    }
  });

  it("the leading slash is normalised away so roots resolve consistently", () => {
    const p = parseTwoSourceCompare(`the combined number of TypeScript files across ${VA} and ${VB}`)!;
    expect(p.relA).toBe("vessels/goal-host-vessel/src");
    expect(p.relB).toBe("vessels/ribosome-vessel/src");
  });

  it("comparisons over /vessels trees parse too", () => {
    const p = parseTwoSourceCompare(`Which has more TypeScript files, ${VA} or ${VB}?`)!;
    expect(p.output).toBe("which_diff");
  });

  it("repos/ goals are unchanged — the existing family must not shift", () => {
    const p = parseTwoSourceCompare(
      "the combined number of TypeScript modules across repos/boredom-vessel/src and repos/llm-resolver-vessel/src",
    )!;
    expect(p.output).toBe("combined");
    expect(p.relA).toBe("repos/boredom-vessel/src");
  });

  it("a mixed repos//vessels pair still needs exactly two distinct roots", () => {
    const p = parseTwoSourceCompare(
      `the combined number of TypeScript files across repos/boredom-vessel/src and ${VB}`,
    )!;
    expect(p).not.toBeNull();
    expect(p.relA).toBe("repos/boredom-vessel/src");
    expect(p.relB).toBe("vessels/ribosome-vessel/src");
  });
});
