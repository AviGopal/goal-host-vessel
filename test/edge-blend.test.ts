import { describe, it, expect } from "bun:test";
import { blendEdgeScore, edgeWeight, EDGE_BLEND_K } from "../src/edge-blend";

/**
 * The property that makes this landable: AT ZERO EDGE EVIDENCE THE SCORE IS UNCHANGED.
 *
 * Wiring per-edge composition evidence into selection alters what the substrate picks for every
 * goal, and there is no way to A/B it from here. The blend is therefore designed so that at the
 * current edge coverage it is a mathematical no-op, and shifts only as real evidence accrues.
 * These tests pin that, because "it should be safe" is not the same as "it cannot move".
 */

describe("edgeWeight — no evidence means no influence", () => {
  it("THE SAFETY PROPERTY: zero samples carry zero weight", () => {
    expect(edgeWeight({ alpha: 5, beta: 2, sample_count: 0 })).toBe(0);
    expect(edgeWeight(null)).toBe(0);
    expect(edgeWeight(undefined)).toBe(0);
    expect(edgeWeight({})).toBe(0);
  });

  it("malformed evidence carries zero weight rather than a guessed one", () => {
    // A count without a posterior cannot produce a draw; weighting it would blend against
    // whatever the caller passed as edgeDraw, which is exactly how a silent wrong value enters.
    expect(edgeWeight({ sample_count: 50 })).toBe(0);
    expect(edgeWeight({ alpha: 3, sample_count: 50 })).toBe(0);
    expect(edgeWeight({ alpha: "3", beta: "1", sample_count: 50 })).toBe(0);
  });

  it("weight is exactly 1/2 at K samples, and rises monotonically", () => {
    const e = (n: number) => ({ alpha: 2, beta: 2, sample_count: n });
    expect(edgeWeight(e(EDGE_BLEND_K))).toBeCloseTo(0.5, 10);
    expect(edgeWeight(e(1))).toBeLessThan(edgeWeight(e(5)));
    expect(edgeWeight(e(5))).toBeLessThan(edgeWeight(e(100)));
    expect(edgeWeight(e(10_000))).toBeLessThan(1);
  });
});

describe("blendEdgeScore", () => {
  it("THE REGRESSION: with no edge evidence the global draw survives EXACTLY", () => {
    // Not approximately — identically. Any drift here is a behaviour change at current
    // coverage, which is what this design exists to avoid.
    for (const g of [0, 0.001, 0.37, 0.5, 0.999, 1]) {
      expect(blendEdgeScore(g, null, 0.99)).toBe(g);
      expect(blendEdgeScore(g, { alpha: 9, beta: 1, sample_count: 0 }, 0.99)).toBe(g);
    }
  });

  it("an absent edge DRAW leaves the score alone even when evidence exists", () => {
    expect(blendEdgeScore(0.4, { alpha: 9, beta: 1, sample_count: 100 }, undefined)).toBe(0.4);
  });

  it("an absent global score stays absent — the blend invents nothing", () => {
    expect(blendEdgeScore(undefined, { alpha: 9, beta: 1, sample_count: 100 }, 0.9)).toBeUndefined();
  });

  it("at K samples the result is the midpoint of the two draws", () => {
    const out = blendEdgeScore(0.2, { alpha: 5, beta: 5, sample_count: EDGE_BLEND_K }, 0.8)!;
    expect(out).toBeCloseTo(0.5, 10);
  });

  it("heavy edge evidence dominates, but never fully erases the global draw", () => {
    const out = blendEdgeScore(0, { alpha: 99, beta: 1, sample_count: 1000 }, 1)!;
    expect(out).toBeGreaterThan(0.98);
    expect(out).toBeLessThan(1);
  });

  it("a BAD edge pulls a good global score DOWN — the signal must cut both ways", () => {
    // If only positive edge evidence could move the score, the mechanism would be a
    // ratchet that never learns which pairings fail.
    const out = blendEdgeScore(0.9, { alpha: 1, beta: 99, sample_count: 1000 }, 0.01)!;
    expect(out).toBeLessThan(0.1);
  });

  it("the blend stays within the interval spanned by its two inputs", () => {
    for (const n of [1, 3, 10, 50, 500]) {
      const out = blendEdgeScore(0.3, { alpha: 2, beta: 2, sample_count: n }, 0.7)!;
      expect(out).toBeGreaterThanOrEqual(0.3);
      expect(out).toBeLessThanOrEqual(0.7);
    }
  });
});
