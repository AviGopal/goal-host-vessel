// Thompson draw for the walk's candidate ranking.
//
// WHY THIS MODULE EXISTS (2026-08-16). The walk previously drew its fallback Thompson score as
//
//     (Math.random() ** (1 / alpha)) / (Math.random() ** (1 / beta))
//
// which is NOT a Beta variate. As beta grows, `Math.random() ** (1 / beta)` tends to 1, so the
// denominator — the entire blame term — drops out, and the draw collapses to approximately
// `Math.random() ** (1 / alpha)`: increasing in credit and BLIND TO FAILURE.
//
// Measured against the fleet's own posteriors on the hub, 200k draws per arm:
//
//   arm                                  alpha    beta    mean     P(>0.5) old   P(>0.5) true
//   learned-auto-bridge-shellresult        8.95   53.96   0.142        99.8%          0.00%
//   learned-satisfier-http-response        3.17   30.20   0.095        89.9%          0.00%
//   auto-bridge-code_modification_proposal 1.00  113.59   0.0087       50.4%          0.00%
//
// `producer-pick.ts` promotes a learned scaffold to rank -1 — AHEAD of fresh derivation — when
// `sampledScore > 0.5`. So the more an arm had failed, the more reliably it was reused, which
// inverts law 3 exactly. Blame was landing in `variant_performance_metrics` correctly and being
// annihilated here, at the draw. Auditing both ends of that channel found nothing; the defect was
// the transform in the middle.
//
// Marsaglia-Tsang gamma, then Beta(a,b) = X / (X + Y) for X~Gamma(a,1), Y~Gamma(b,1). Deliberately
// dependency-free: goal-host carries no stats dependency, and activity-api's correct sampler
// (`routes/activities.scoring.ts`) sits behind @stdlib in a different vessel.

/** Standard normal via Box-Muller. */
export function standardNormalSample(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) via Marsaglia-Tsang. Returns 0 for a non-finite or non-positive shape. */
export function gammaSample(shape: number): number {
  if (!Number.isFinite(shape) || shape <= 0) return 0;
  // Marsaglia-Tsang requires shape >= 1; boost a smaller shape via
  // Gamma(a) = Gamma(a + 1) * U^(1/a).
  if (shape < 1) {
    return gammaSample(shape + 1) * Math.pow(Math.random() || Number.MIN_VALUE, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let guard = 0; guard < 1000; guard++) {
    let x = 0;
    let v = 0;
    do {
      x = standardNormalSample();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u || Number.MIN_VALUE) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // acceptance loop exhausted (statistically unreachable) — fall back to the mode
}

/**
 * Beta(alpha, beta) sample. Falls back to 0.5 on invalid parameters (an uninformative draw,
 * matching an untried Beta(1,1)) and to the posterior mean if both gamma draws underflow.
 */
export function betaSample(alpha: number, betaParam: number): number {
  if (!Number.isFinite(alpha) || !Number.isFinite(betaParam) || alpha <= 0 || betaParam <= 0) {
    return 0.5;
  }
  const x = gammaSample(alpha);
  const y = gammaSample(betaParam);
  const s = x + y;
  if (!Number.isFinite(s) || s <= 0) return alpha / (alpha + betaParam);
  return x / s;
}
