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
  let best: SatisfierProducer | undefined;
  let bestScore = -Infinity;
  for (const p of producers) {
    const score = typeof p["priority"] === "number" ? (p["priority"] as number) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best ?? producers[0];
}
