/**
 * Capability-gap demand (fileCapabilityGap, index.ts), as pure functions so the rule is testable without booting the vessel.
 *
 * DEMAND-COUNTED FILING (openspec contained-self-development 8.15): a missing shape is real demand when a SECOND distinct goal
 * needs it; a first demand is a walk artifact, recorded closed. RECURRING DEMAND (8.14, "revisit only for shapes with recurring
 * demand"; 2026-10-13): the SAME goal is demand too once it is already on this shape's row and has failed at least `minRuns`
 * times since its last reach (R2's min_runs). A one-off goal, and any goal's first demand for a shape, stays born closed.
 */

/** The failures of one goal recorded after its last reach (a failure from before the goal last reached never counts). */
export function exactFailuresSince<T extends { at: string }>(records: readonly T[], lastReachedAt: string): T[] {
  return records.filter((r) => r.at > lastReachedAt);
}

/**
 * The goal's distinct failed RUNS after its last reach. A run writes one failure record per judged reason (up to three), all stamped
 * in the same instant, so records count attempts and reasons, not runs: a single dispatch with three reasons is ONE run. A run is
 * keyed by its stamp to the second (two runs of one goal never land in the same second). Counted over every recorded stamp, not the
 * failure-recall window (which keeps only a goal's last few records), so N runs are countable whatever N is.
 */
export function distinctRunsSince(stamps: Iterable<string>, lastReachedAt: string): number {
  const runs = new Set<string>();
  for (const at of stamps) if (typeof at === "string" && at > lastReachedAt) runs.add(at.slice(0, 19));
  return runs.size;
}

export interface CapabilityDemandInput {
  /** The goals already on the gap row (demand_goals strings). */
  priorGoals: readonly string[];
  /** This goal's key (its text, trimmed, first 300 chars). */
  goalKey: string;
  /** This goal's distinct failed RUNS since its last reach (distinctRunsSince), never its record count. */
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
  // Recurring is the same goal for the SAME shape: only a goal already on this shape's row can recur. A goal's FIRST demand for a
  // shape is a walk artifact (born closed, 8.15) however often that goal has failed: one goal yields a different inferred name per run.
  const seen = i.priorGoals.includes(i.goalKey);
  const recurring = seen && i.priorFailures > 0 && i.minRuns > 0 && i.priorFailures >= i.minRuns;
  if (seen && !recurring) return { skip: true, demandGoals: [...i.priorGoals], demanded: false, recurring: false };
  const demandGoals = (seen ? [...i.priorGoals] : [...i.priorGoals, i.goalKey]).slice(-10);
  return { skip: false, demandGoals, demanded: demandGoals.length >= 2 || recurring, recurring };
}
