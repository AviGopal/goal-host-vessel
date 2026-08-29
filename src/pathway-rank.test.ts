// Pins the pathway-reuse ranking fix.
//
// THE DEFECT (filed): pathway-reuse-ranks-by-raw-success-count-starves-verified-floor.
// `recommendReachingPath` ranked eligible pathways by raw `successful_executions`
// count, so a 40/100 pathway permanently outranked a 9/10 one — volume beat
// reliability. This module replaces that comparator with a Wilson-score-based
// confidence ranking and is tested directly since importing index.ts boots a server.
import { describe, expect, test } from "bun:test";
import { comparePathways, confidenceOf, modeRank, wilsonLowerBound } from "./pathway-rank";

describe("wilsonLowerBound", () => {
  test("zero trials has zero confidence", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  test("a small perfect sample is discounted below a large, slightly-imperfect one", () => {
    // The exact failure a naive rate sort introduces: 1/1 (rate 1.0) must NOT
    // outrank 9/10 (rate 0.9) once sample size is accounted for.
    expect(wilsonLowerBound(1, 1)).toBeLessThan(wilsonLowerBound(9, 10));
  });

  test("more evidence at the same rate yields more confidence", () => {
    expect(wilsonLowerBound(9, 10)).toBeLessThan(wilsonLowerBound(90, 100));
  });

  test("a lower raw success count with a far better rate outranks a higher-volume mediocre pathway", () => {
    // The original defect: 40/100 (rate 0.4) must NOT outrank 9/10 (rate 0.9).
    expect(wilsonLowerBound(40, 100)).toBeLessThan(wilsonLowerBound(9, 10));
  });
});

describe("modeRank", () => {
  test("exact goal-hash match ranks before shape-signature nearby match", () => {
    expect(modeRank({ match_mode: "goal_hash" })).toBe(0);
    expect(modeRank({ match_mode: "shape_signature" })).toBe(1);
    expect(modeRank({})).toBe(0);
  });
});

describe("comparePathways", () => {
  test("a verified 9/10 pathway outranks a high-volume 40/100 pathway", () => {
    const proven = { successful_executions: 9, total_executions: 10 };
    const volume = { successful_executions: 40, total_executions: 100 };
    const sorted = [volume, proven].sort(comparePathways);
    expect(sorted[0]).toBe(proven);
  });

  test("a proven 9/10 pathway outranks a fresh 1/1 pathway", () => {
    const proven = { successful_executions: 9, total_executions: 10 };
    const fresh = { successful_executions: 1, total_executions: 1 };
    const sorted = [fresh, proven].sort(comparePathways);
    expect(sorted[0]).toBe(proven);
  });

  test("exact match always outranks shape-signature match regardless of confidence", () => {
    const exactWeak = { match_mode: "goal_hash", successful_executions: 2, total_executions: 5 };
    const nearbyStrong = { match_mode: "shape_signature", successful_executions: 95, total_executions: 100 };
    const sorted = [nearbyStrong, exactWeak].sort(comparePathways);
    expect(sorted[0]).toBe(exactWeak);
  });

  test("equal confidence ties break on total experience", () => {
    const moreExperience = { successful_executions: 90, total_executions: 100 };
    const lessExperience = { successful_executions: 9, total_executions: 10 };
    const sorted = [lessExperience, moreExperience].sort(comparePathways);
    expect(sorted[0]).toBe(moreExperience);
  });
});

describe("confidenceOf", () => {
  test("non-numeric or missing fields do not throw and count as zero evidence", () => {
    expect(confidenceOf({})).toBe(0);
    expect(confidenceOf({ successful_executions: "nine" as unknown as number, total_executions: 10 })).toBeCloseTo(0, 9);
  });
});
