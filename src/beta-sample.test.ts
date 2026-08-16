import { describe, expect, test } from "bun:test";
import { betaSample, gammaSample } from "./beta-sample";
import { makeProducerPickHelpers } from "./producer-pick";

// These tests assert the DISTRIBUTION, not merely that a number comes out. The defect this
// module replaced returned a perfectly well-typed, finite, positive number for every input —
// it typechecked, it never threw, and it was wrong. Only the moments catch that.

const N = 60_000;

function moments(a: number, b: number): { mean: number; variance: number; pGt: number } {
  let s = 0;
  let s2 = 0;
  let gt = 0;
  for (let i = 0; i < N; i++) {
    const v = betaSample(a, b);
    s += v;
    s2 += v * v;
    if (v > 0.5) gt++;
  }
  const mean = s / N;
  return { mean, variance: s2 / N - mean * mean, pGt: gt / N };
}

describe("betaSample matches Beta(alpha, beta)", () => {
  const cases: Array<[number, number]> = [
    [1, 1],
    [2, 5],
    [1.81, 1.19],
    [0.5, 0.5],
    [3.17, 30.2],
    [8.95, 53.96],
    [1, 113.59],
  ];

  for (const [a, b] of cases) {
    test(`Beta(${a}, ${b}) mean and variance`, () => {
      const trueMean = a / (a + b);
      const trueVar = (a * b) / ((a + b) ** 2 * (a + b + 1));
      const { mean, variance } = moments(a, b);
      // 4 sigma of the sample mean, plus a small absolute floor for tiny-variance cases.
      const meanTol = 4 * Math.sqrt(trueVar / N) + 1e-3;
      expect(Math.abs(mean - trueMean)).toBeLessThan(meanTol);
      expect(Math.abs(variance - trueVar)).toBeLessThan(0.1 * trueVar + 1e-5);
    });
  }

  test("stays inside [0, 1] and is always finite", () => {
    for (let i = 0; i < 20_000; i++) {
      const v = betaSample(Math.random() * 40 + 0.01, Math.random() * 120 + 0.01);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("invalid parameters yield an uninformative 0.5 rather than NaN", () => {
    for (const [a, b] of [[0, 1], [1, 0], [-1, 5], [NaN, 2], [2, Infinity]] as Array<[number, number]>) {
      expect(betaSample(a, b)).toBe(0.5);
    }
  });

  test("gammaSample handles shape < 1 (the Marsaglia-Tsang boost branch)", () => {
    let s = 0;
    for (let i = 0; i < 40_000; i++) s += gammaSample(0.3);
    expect(Math.abs(s / 40_000 - 0.3)).toBeLessThan(0.02); // E[Gamma(0.3,1)] = 0.3
  });
});

// THE REGRESSION THIS EXISTS TO PREVENT. The old expression cleared producer-pick's reuse gate
// for heavily-blamed arms almost always; a correct Beta essentially never does. If the sampler is
// ever swapped back for something that ignores beta, these fail immediately.
describe("blame reaches the producer-pick reuse gate", () => {
  const { scaffoldRank } = makeProducerPickHelpers((id) => id);
  const targets = new Set(["shellResult"]);

  const rankShareMinusOne = (a: number, b: number): number => {
    let promoted = 0;
    const runs = 4000;
    for (let i = 0; i < runs; i++) {
      const rank = scaffoldRank(
        { id: "learned-compose-x-to-y", outputShapes: ["shellResult"], sampledScore: betaSample(a, b) },
        targets,
      );
      if (rank === -1) promoted++;
    }
    return promoted / runs;
  };

  test("a heavily blamed arm is almost never promoted ahead of fresh derivation", () => {
    expect(rankShareMinusOne(8.95, 53.96)).toBeLessThan(0.01); // old formula: ~0.998
    expect(rankShareMinusOne(3.17, 30.2)).toBeLessThan(0.01); // old formula: ~0.899
    expect(rankShareMinusOne(1, 113.59)).toBeLessThan(0.01); // old formula: ~0.504
  });

  test("a genuinely good arm is still reused", () => {
    expect(rankShareMinusOne(1.81, 1.19)).toBeGreaterThan(0.5);
  });

  test("an untried arm explores at about a coin flip", () => {
    const share = rankShareMinusOne(1, 1);
    expect(share).toBeGreaterThan(0.44);
    expect(share).toBeLessThan(0.56);
  });
});
