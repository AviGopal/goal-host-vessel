import { describe, it, expect } from "bun:test";
import { registryFieldFor, registryCountCommandFor } from "../src/registry-field";

/**
 * THE PRECISE PHRASING WAS THE ONE THAT DID NOT WORK.
 *
 * Measured 2026-08-17 by dispatching the ladder and hand-grading. "Report the totalShapes
 * value from the discovery registry at http://localhost:18100/registry/stats as a single
 * number" produced NO deterministic producer; the walk then inferred `webSearchResult` for
 * a goal carrying an explicit localhost URL and the resolver rejected it ("query is
 * required"). The vaguer "how many shapes does the registry have" matched and answered.
 *
 * Every matcher above keyed on conversational counting phrases — "how many", "number of",
 * "total <noun>" — and none fires on `totalShapes`, a single token. So naming the
 * registry's own published field was strictly LESS likely to be understood than describing
 * it loosely. That inverts law 13: it teaches an operator to write vaguer goals.
 *
 * ⚠ THIS ALSO CORRECTS MY OWN REPORT. I called the failing rung "a regression, since that
 * rung passed earlier in this session". It was not a regression — I had changed the goal
 * wording between the two runs and compared them as if they were the same goal. Two
 * different goals is not a before/after. The finding survived; the framing did not.
 */

describe("registry field — canonical names are read", () => {
  it("THE REGRESSION: the registry's own field names resolve", () => {
    expect(registryFieldFor("Report the totalShapes value from the discovery registry")).toBe("totalShapes");
    expect(registryFieldFor("what is the totalVessels count")).toBe("totalVessels");
    expect(registryFieldFor("report registry healthyCount")).toBe("healthyCount");
  });

  it("the full failing goal, verbatim, now produces a command", () => {
    const goal = "Report the totalShapes value from the discovery registry at http://localhost:18100/registry/stats as a single number.";
    expect(registryFieldFor(goal)).toBe("totalShapes");
    expect(registryCountCommandFor(goal, "http://x:8100")).toBe("curl -s http://x:8100/registry/stats | jq .totalShapes");
  });

  it("the conversational phrasings still work — this is additive", () => {
    expect(registryFieldFor("how many shapes does the registry have")).toBe("totalShapes");
    expect(registryFieldFor("number of vessels")).toBe("totalVessels");
    expect(registryFieldFor("how many healthy vessels")).toBe("healthyCount");
  });
});

describe("registry field — the new route must not reopen the abstentions", () => {
  /**
   * The whole risk of adding a second way in. Being reachable by another route must not
   * make a goal reachable by a WRONG route: the oracle and the synthesiser share this
   * function, so anything it returns is confirmed rather than checked. A field name
   * appearing inside a compositional goal must still abstain.
   */
  it("arithmetic over named fields still abstains", () => {
    expect(registryFieldFor("divide totalShapes by totalVessels")).toBeNull();
    expect(registryFieldFor("the ratio of totalShapes to totalVessels")).toBeNull();
    expect(registryFieldFor("totalShapes per vessel")).toBeNull();
    expect(registryFieldFor("the average totalShapes")).toBeNull();
  });

  it("TWO different named fields abstain, exactly like two counted entities", () => {
    // Picking the first would be the dropped-operand failure that cost an alpha +2 on a
    // wrong answer earlier today, arriving by a new door.
    expect(registryFieldFor("report totalShapes and totalVessels")).toBeNull();
    expect(registryFieldFor("sum totalShapes and healthyCount")).toBeNull();
  });

  it("the SAME field named twice is not ambiguity", () => {
    expect(registryFieldFor("report the totalShapes value; totalShapes only")).toBe("totalShapes");
  });

  it("documents a FALSE abstention found while writing this file: 'i mean' matches /\\bmean\\b/", () => {
    // The first draft of the test above used "report totalShapes, i mean the totalShapes
    // value" and returned null. Not the duplicate-name logic — the arithmetic guard, whose
    // pattern includes `mean` (as in average) and therefore fires on the English filler
    // "I mean". Same for "on average" phrasing anywhere in a goal.
    //
    // LEFT UNFIXED ON PURPOSE, and pinned here so it is a known property rather than a
    // surprise. The failure direction is the safe one: a false abstention costs one LLM
    // judgement, while a false MATCH is blessed by a verifier sharing this same function
    // and poisons the posterior of an arm that was right. Narrowing `mean` to avoid the
    // filler risks admitting a real "mean" goal that has no oracle. If this ever starts
    // costing real reaches, the fix is an oracle for averages, not a looser guard.
    expect(registryFieldFor("report totalShapes, i mean the value")).toBeNull();
  });

  it("a goal naming no registry field is still null", () => {
    expect(registryFieldFor("what is the weather")).toBeNull();
    expect(registryFieldFor("count the .ts files in src")).toBeNull();
  });

  it("NEGATIVE CONTROL: the counting-phrase abstentions are untouched", () => {
    // If this ever passes something, the additive change has eaten the guard above it.
    expect(registryFieldFor("divide the total shape count by the total vessel count")).toBeNull();
    expect(registryFieldFor("how many shapes per vessel")).toBeNull();
  });
});
