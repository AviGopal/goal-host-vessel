/**
 * Ranks candidate reusable pathways returned by `/v2/goal-paths/recommend`.
 *
 * WHY THIS EXISTS. `recommendReachingPath` used to rank eligible pathways by
 * raw `successful_executions` count. That ranks a 40/100 pathway above a 9/10
 * one — a mediocre-but-often-picked pathway permanently starves a sparse,
 * verified-reliable one from ever being selected, because "most executions"
 * and "most trustworthy" are different things (filed:
 * pathway-reuse-ranks-by-raw-success-count-starves-verified-floor).
 *
 * A naive success-RATE sort flips to the opposite failure: a brand-new 1/1
 * pathway (rate 1.0, one lucky reach) would outrank a 9/10 pathway despite
 * having a fraction of the evidence behind it. The Wilson score lower bound is
 * the standard fix for exactly this tradeoff: it is a confidence-discounted
 * rate that only ranks a small sample highly when its observed rate is high
 * AND the sample is large enough to trust that rate.
 *
 * Extracted into its own module so it can be tested at all — importing
 * `index.ts` boots an HTTP server, and testing a copy of the comparator is the
 * self-confirming trap.
 */

/**
 * 95% Wilson score lower bound for a Bernoulli success rate observed over
 * `total` trials. Returns 0 for `total <= 0` (no evidence, no confidence).
 */
export function wilsonLowerBound(successes: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.96; // 95% confidence
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return (center - margin) / denom;
}

export interface RankablePathway {
  match_mode?: unknown;
  successful_executions?: unknown;
  total_executions?: unknown;
}

const countOf = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Exact goal-hash matches always outrank shape-signature "nearby" matches. */
export function modeRank(p: RankablePathway): number {
  return p?.match_mode === "shape_signature" ? 1 : 0;
}

export function confidenceOf(p: RankablePathway): number {
  return wilsonLowerBound(countOf(p.successful_executions), countOf(p.total_executions));
}

/**
 * Comparator for `Array.prototype.sort`: exact-match before shape-signature,
 * then most-CONFIDENT first (Wilson lower bound, not raw count), then most
 * total experience as the final tiebreak among equally-confident pathways.
 */
export function comparePathways(a: RankablePathway, b: RankablePathway): number {
  return (modeRank(a) - modeRank(b)) || (confidenceOf(b) - confidenceOf(a)) || (countOf(b.total_executions) - countOf(a.total_executions));
}
