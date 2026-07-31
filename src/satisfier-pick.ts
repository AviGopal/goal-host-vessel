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
    const score = typeof p["priority"] === "number" ? (p["priority"] as number) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best ?? pool[0];
}
