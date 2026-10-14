/**
 * Capability-gap demand (fileCapabilityGap, index.ts), as pure functions so the rule is testable without booting the vessel.
 *
 * DEMAND-COUNTED FILING (openspec contained-self-development 8.15): a missing shape is real demand when a SECOND distinct goal
 * needs it; a first demand is a walk artifact, recorded closed. RECURRING DEMAND (8.14, "revisit only for shapes with recurring
 * demand"; 2026-10-13): the SAME goal is demand too once it has failed at least `minRuns` times since its last reach (R2's
 * min_runs). A one-off goal stays born closed until it recurs.
 */

/** The failures of one goal recorded after its last reach (a failure from before the goal last reached never counts). */
export function exactFailuresSince<T extends { at: string }>(records: readonly T[], lastReachedAt: string): T[] {
  return records.filter((r) => r.at > lastReachedAt);
}

export interface CapabilityDemandInput {
  /** The goals already on the gap row (demand_goals strings). */
  priorGoals: readonly string[];
  /** This goal's key (its text, trimmed, first 300 chars). */
  goalKey: string;
  /** This goal's failures since its last reach. */
  priorFailures: number;
  /** R2's min_runs (goalDeficiencyPolicy). */
  minRuns: number;
}
export interface CapabilityDemand {
  /** Nothing to write: the same goal again, not recurring. */
  skip: boolean;
  demandGoals: string[];
  /** File OPEN (true) or as a closed walk artifact (false). */
  demanded: boolean;
  /** Opened because the same goal recurs, not because a second goal needs the shape. */
  recurring: boolean;
}
export function capabilityDemand(i: CapabilityDemandInput): CapabilityDemand {
  const recurring = i.priorFailures > 0 && i.minRuns > 0 && i.priorFailures >= i.minRuns;
  const seen = i.priorGoals.includes(i.goalKey);
  if (seen && !recurring) return { skip: true, demandGoals: [...i.priorGoals], demanded: false, recurring: false };
  const demandGoals = (seen ? [...i.priorGoals] : [...i.priorGoals, i.goalKey]).slice(-10);
  return { skip: false, demandGoals, demanded: demandGoals.length >= 2 || recurring, recurring };
}
