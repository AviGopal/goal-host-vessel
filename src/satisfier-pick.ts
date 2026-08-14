/**
 * Satisfier-tier producer pick for vessel-resolve walks.
 * Extracted from index.ts for isolated improvement of walk-selection logic
 * (prior-failure exclusion, honest decline).
 */

export interface SatisfierProducer {
  endpoint: string;
  resolve_endpoint?: string;
  [key: string]: unknown;
}

/**
 * Is a satisfier PROVEN-BAD by its Thompson posterior? (§12.6 step 3, 2026-08-14)
 *
 * The satisfier plane accumulates a posterior (the write-back works: satisfier:pull_cutover
 * sits at α=1.7/β=41.9 over 148 executions) but the walk never READS it — so a satisfier the
 * learner has heavily penalised keeps being picked, stealing selection from earned pathways.
 * This gate lets the walk PREFER a composition/producer over a satisfier the posterior has
 * already condemned. Proven-bad ⇔ reliability (mean of Beta(α,β)) below `floor` AND enough
 * samples to trust the estimate. Conservative by construction: too few samples ⇒ NOT proven-bad
 * (benefit of the doubt), so a fresh or lightly-used satisfier is never suppressed.
 */
export function satisfierProvenBad(
  alpha: number,
  beta: number,
  samples: number,
  floor = 0.3,
  minSamples = 10,
): boolean {
  if (!Number.isFinite(alpha) || !Number.isFinite(beta) || alpha <= 0 || beta <= 0) return false;
  if (!Number.isFinite(samples) || samples < minSamples) return false;
  const reliability = alpha / (alpha + beta);
  return reliability < floor;
}

export function pickSatisfierProducer(
  producers: SatisfierProducer[],
): SatisfierProducer | undefined {
  if (producers.length === 0) return undefined;
  // Honor a producer's self-declared distribution rule BEFORE scoring by priority,
  // matching discovery /resolve (discovery-vessel 7e051d7) and the federation
  // transport ingress pick (24ac13e2): a unique_authoritative / stateful_data_owner_pin
  // owner must win over interchangeable replicas, else the walk's own pick silently
  // overrides the vessel's declared rule. distribution_policy rides through on the
  // discovery capability row (echoed since 6ab2e24). Among the eligible producers
  // (the pinned owners when any exist, else all) the existing priority score decides.
  const isPinned = (p: SatisfierProducer) => {
    const pol = String(p["distribution_policy"] ?? "stateless");
    return pol === "unique_authoritative" || pol === "stateful_data_owner_pin";
  };
  const pool = producers.some(isPinned) ? producers.filter(isPinned) : producers;
  let best: SatisfierProducer | undefined;
  let bestScore = -Infinity;
  for (const p of pool) {
    const isRemote = String(p["protocol"] ?? "") === "libp2p"; const score = (typeof p["priority"] === "number" ? (p["priority"] as number) : 0) * 2 + (isRemote ? 0 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best ?? pool[0];
}
