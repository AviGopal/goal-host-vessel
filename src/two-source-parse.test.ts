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
