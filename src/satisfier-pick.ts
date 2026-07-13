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
  return producers[0];
}
