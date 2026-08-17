/**
 * Blending per-EDGE composition evidence into a candidate's selection score.
 *
 * THE DEFECT THIS CLOSES (measured 2026-08-17, selection-mechanism review).
 *
 * The walk scored every step by the candidate's GLOBAL Thompson posterior and never by how
 * that candidate performed AFTER the activity that just ran. A walk was therefore a sequence
 * of independent single-arm draws — memoryless with respect to composition. Per-edge credit
 * accumulated in `activity_composition_graph`, the store could compute a per-edge Beta from
 * it, and the picking path never queried it.
 *
 * Two things kept it invisible, and BOTH had to move:
 *   1. the store only attaches `composition_score` under `mode:"candidates_with_scores"`,
 *      which also forces the query direction to forward — so the walk (which runs both
 *      directions) could not safely ask for it. Fixed store-side with an `include_scores`
 *      flag orthogonal to direction.
 *   2. the walk read `x.composition_score` through a `typeof v === "number"` guard while the
 *      store emits an OBJECT, so it always yielded undefined. Fixed here.
 * Changing either alone is inert — the same trap as a corrected URL with an uncorrected
 * response key.
 *
 * WHY BLEND RATHER THAN REPLACE. Replacing the global draw with the edge draw would starve
 * every edge that has never been tried: an untried edge has no samples and would always lose
 * to a tried one, so no new composition could ever earn evidence. That is the untried-prior
 * problem one level up, and this codebase has already measured what an over-confident prior
 * does to selection (a .755-success arm won 0.0% of draws against ~76 near-uniform arms).
 *
 * The weight is the edge's own sample count over (count + K):
 *   0 samples -> w = 0  -> the score is EXACTLY the global draw
 *   K samples -> w = 0.5
 *   many      -> w -> 1 -> specific evidence dominates the general
 *
 * The no-op-at-zero property is what makes this landable without a live A/B: at current edge
 * coverage the ranking is unchanged, and it shifts only as real edge evidence accrues.
 */

/** Edge-evidence half-life: at K samples on an A->B edge, the per-edge posterior carries half
 *  the weight of the candidate's global posterior.
 *
 *  THIS IS THE DEFAULT, NOT THE SETTING. It was originally justified here as "a tuning
 *  constant in the same sense as the walk's MAX_STEPS" — which law 1 forbids for anything
 *  behavioural, and K is behavioural: it decides how fast specific evidence overtakes
 *  general. Citing MAX_STEPS did not license it, it identified a second violation.
 *
 *  The live value is resolved at use time from the policy volume by selection-tuning.ts,
 *  which imports this as its fallback so the unconfigured path is byte-for-byte what
 *  shipped before. Keep the number HERE (the math lives here) and the resolution THERE;
 *  declaring it in both places is two constants that drift the first time either is
 *  tuned. */
export const EDGE_BLEND_K = 10;

export interface EdgeEvidence {
  alpha?: unknown;
  beta?: unknown;
  sample_count?: unknown;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * The weight per-edge evidence should carry, in [0,1).
 *
 * Returns 0 for absent, malformed or zero-sample evidence — every path that cannot justify
 * moving the score leaves it exactly alone.
 */
export function edgeWeight(edge: EdgeEvidence | null | undefined, k: number = EDGE_BLEND_K): number {
  const samples = num(edge?.sample_count) ?? 0;
  if (!(samples > 0)) return 0;
  if (num(edge?.alpha) === undefined || num(edge?.beta) === undefined) return 0;
  if (!(k > 0)) return 0;
  return samples / (samples + k);
}

/**
 * Blend a global Thompson draw with a per-edge draw.
 *
 * `edgeDraw` is supplied by the caller (the walk passes a Beta sample over the edge's α/β) so
 * this stays pure and the randomness lives at one call site.
 */
export function blendEdgeScore(
  globalScore: number | undefined,
  edge: EdgeEvidence | null | undefined,
  edgeDraw: number | undefined,
  k: number = EDGE_BLEND_K,
): number | undefined {
  if (globalScore === undefined) return undefined;
  const w = edgeWeight(edge, k);
  if (w === 0 || edgeDraw === undefined) return globalScore;
  return (1 - w) * globalScore + w * edgeDraw;
}
