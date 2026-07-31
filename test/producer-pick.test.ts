import { describe, expect, test } from "bun:test";
import { makeProducerPickHelpers } from "../src/producer-pick";

const { scaffoldRank } = makeProducerPickHelpers((id: string) => id); // identity normActivityId
const T = new Set(["conceptDescription"]);
const scaffold = (over: Record<string, unknown> = {}) => ({
  id: "learned-compose-analyze-source-to-concept", // matches isHollowScaffold
  outputShapes: ["conceptDescription"],
  ...over,
});

describe("scaffoldRank cold-start selection (B3)", () => {
  test("cold scaffold, no sampledScore, covers target => 0", () => {
    expect(scaffoldRank(scaffold({ sampledScore: undefined }), T)).toBe(0);
  });
  test("unlucky-low sampledScore, covers target => 0", () => {
    expect(scaffoldRank(scaffold({ sampledScore: 0.3 }), T)).toBe(0);
  });
  test("proven scaffold (sampledScore>0.5), covers target => -1 (reuse bonus preserved)", () => {
    expect(scaffoldRank(scaffold({ sampledScore: 0.9 }), T)).toBe(-1);
  });
  test("high-posterior scaffold NOT covering target => 1 (no noise promotion)", () => {
    expect(scaffoldRank(scaffold({ outputShapes: ["tool_output"], sampledScore: 0.9 }), T)).toBe(1);
  });
  test("no/empty targetShapes => scaffold stays 1 (genuine-first default)", () => {
    expect(scaffoldRank(scaffold({ sampledScore: 0.9 }))).toBe(1);
    expect(scaffoldRank(scaffold({ sampledScore: 0.9 }), new Set())).toBe(1);
  });
  test("genuine (non-scaffold) producer => 0 (unaffected)", () => {
    expect(scaffoldRank({ id: "analyze-source", outputShapes: ["conceptDescription"] }, T)).toBe(0);
  });
});
