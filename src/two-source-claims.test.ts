import { describe, expect, it } from "bun:test";

import { claimedDifference, claimedWinner } from "./two-source-claims";

const A = "repos/llm-resolver-vessel/src";
const B = "repos/boredom-vessel/src";

/**
 * The verifier these feed is deterministic and self-confirming when it gets this wrong:
 * it computes the authoritative answer, then decides the output agrees. A false agreement
 * alpha-credits a wrong answer AND writes it into the durable artifact as verified.
 */
describe("claimedDifference", () => {
  it("OBSERVED LIVE: reads the difference the output actually states", () => {
    // dispatch 188132ba — authoritative difference was 4; the output said "1 fewer" and
    // was graded reached because a stray "4" (a WRONG count) appeared elsewhere.
    const digest = `${A} has 1 fewer TypeScript module than ${B}.\n{"shape":"shellResult","stdout":"${A}: 4\\n"}`;
    expect(claimedDifference(digest)).toBe(1);
  });

  it("reads the other phrasings these outputs use", () => {
    expect(claimedDifference("it has 3 more modules")).toBe(3);
    expect(claimedDifference("difference: 12")).toBe(12);
    expect(claimedDifference("difference of 7")).toBe(7);
    expect(claimedDifference("the combined total differs by 5")).toBe(5);
  });

  it("returns null when the output states no difference, so the weaker check still applies", () => {
    expect(claimedDifference("both directories were counted")).toBeNull();
    expect(claimedDifference('{"stdout":"7\\n"}')).toBeNull();
  });
});

describe("claimedWinner", () => {
  it("names the source the output declares, not merely one that appears", () => {
    // A comparison mentions BOTH sources, which is why "the winner's name is present"
    // could never discriminate.
    expect(claimedWinner(`${A} has 1 fewer TypeScript module than ${B}.`, A, B)).toBe(A);
    expect(claimedWinner(`${B} has more TypeScript modules than ${A}.`, A, B)).toBe(B);
  });

  it("reads the inverted phrasing", () => {
    expect(claimedWinner(`the smaller of the two is ${A}`, A, B)).toBe(A);
    expect(claimedWinner(`the larger is ${B}`, A, B)).toBe(B);
  });

  it("returns null when the output declares no winner", () => {
    expect(claimedWinner(`counted ${A} and ${B}`, A, B)).toBeNull();
  });

  it("does not treat a bare mention as a declaration", () => {
    // The exact failure mode of the check it replaces.
    expect(claimedWinner(`${A}: 4\n${B}: 6`, A, B)).toBeNull();
  });
});
