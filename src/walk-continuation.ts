/**
 * Walk continuation decision — extracted from index.ts satisfier-production
 * acceptance, no-progress step counting, and walk-termination logic.
 *
 * All closure values are passed as explicit parameters; the function is pure
 * (no side-effects, no I/O) so it is straightforward to unit-test in isolation.
 */

export interface ContinuationParams {
  /** The produced shape name from the current walk step (empty string = no production). */
  producedShape: string;
  /** Accumulated no-progress step count entering this decision. */
  noProgressCount: number;
  /** Termination reason accumulated so far (null = not yet terminated). */
  terminationReason: string | null;
  /** Whether the produced shape satisfies the target (caller computes this). */
  satisfiesTarget: boolean;
  /** Whether this step produced any meaningful output (caller computes this). */
  madeProgress: boolean;
  /** Maximum consecutive no-progress steps before termination. */
  maxNoProgressSteps: number;
  /** Hard upper bound on walk steps. */
  maxWalkSteps: number;
  /** Current walk step index (0-based). */
  stepIndex: number;
}

export interface ContinuationResult {
  /** Whether the produced shape/step is accepted as satisfying the walk goal. */
  accepted: boolean;
  /** Updated no-progress counter (incremented when no progress was made). */
  noProgressCount: number;
  /** Termination reason if the walk should stop, null if it should continue. */
  terminationReason: string | null;
}

/**
 * Decide whether the current walk step is accepted, update the no-progress
 * counter, and determine whether the walk should terminate (and why).
 *
 * This function encapsulates the satisfier-production acceptance check,
 * the no-progress step counter update, and the walk-termination reason
 * accumulation that previously lived inline in the walk loop in index.ts.
 */
export function decideContinuation(params: ContinuationParams): ContinuationResult {
  const {
    producedShape,
    noProgressCount: incomingNoProgressCount,
    terminationReason: incomingTerminationReason,
    satisfiesTarget,
    madeProgress,
    maxNoProgressSteps,
    maxWalkSteps,
    stepIndex,
  } = params;

  // A step is accepted when it produces a non-empty shape that satisfies the target.
  const accepted = producedShape.length > 0 && satisfiesTarget;

  // Update the no-progress counter: reset on progress, increment otherwise.
  const noProgressCount = madeProgress ? 0 : incomingNoProgressCount + 1;

  // Accumulate termination reason (first reason wins; subsequent steps cannot
  // override an already-set reason).
  let terminationReason = incomingTerminationReason;

  if (terminationReason === null) {
    if (noProgressCount >= maxNoProgressSteps) {
      terminationReason =
        `no_progress_limit_reached (${noProgressCount} consecutive steps without progress, limit ${maxNoProgressSteps})`;
    } else if (stepIndex + 1 >= maxWalkSteps) {
      terminationReason =
        `max_walk_steps_reached (step ${stepIndex + 1} of ${maxWalkSteps})`;
    }
  }

  return { accepted, noProgressCount, terminationReason };
}
