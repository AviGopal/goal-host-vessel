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

/**
 * WHICH OF A REPO'S COMPOSE OWNERS TAKES AN EDIT (REALIGNMENT §4, law 11). Several owners may compose one repo; the
 * landing lease serialises their landings (development-vessel owns that decision: its gap policy's owned vessels, its
 * composeOwnership answer). The pick among them used to be capacity-blind: priority over every row, so a full owner
 * took the edit while another owner sat idle, and the edit came back BUSY. `freeSlots` is each owner's free compose
 * slots as its own composeOwnership placement answer reported them (null: unobservable). One owner is today's route;
 * among several, the most free slots wins (ties by the existing priority pick); none observably free keeps the
 * priority pick among the owners, whose BUSY is the same non-attempt as before. Pure.
 */
export function pickComposeOwner<T extends SatisfierProducer>(owners: T[], freeSlots: (o: T) => number | null): T | undefined {
  if (owners.length <= 1) return owners[0];
  const free = owners.map((o) => ({ o, n: freeSlots(o) })).filter((x): x is { o: T; n: number } => typeof x.n === "number" && x.n > 0);
  if (free.length === 0) return pickSatisfierProducer(owners) as T | undefined;
  const most = Math.max(...free.map((x) => x.n));
  return pickSatisfierProducer(free.filter((x) => x.n === most).map((x) => x.o)) as T | undefined;
}
