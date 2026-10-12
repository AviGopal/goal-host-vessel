/**
 * ALTERNATIVE-FRAMING ACCEPTANCE: when the original walk was hollow and the walk re-ran against an
 * alternative target framing, does the re-framed walk's reach stand in for the ORIGINAL goal?
 *
 * The re-framing retry fires only after the original walk was hollow, so a re-framed reach must not move
 * the goalposts. It is rejected when:
 *   - it produced only punt or walk-mechanics shapes (a hand-off, not an answer);
 *   - the original framing wanted a DERIVED answer and the re-frame produced only raw-input shapes
 *     (derivation-over-source);
 *   - the walk planned a retrieval and the re-frame answered without retrieving anything.
 */
import type { ReframeAcceptInput } from "../judge/records";
import type { ReframeDecision } from "../judge/classes";

export function accept(i: ReframeAcceptInput): ReframeDecision {
  const a = i.alt_walk;
  const hasSubstance = a.substantive_shapes.length > 0 && !(i.orig_wanted_derived && a.only_raw_input) && !a.skipped_planned_retrieval;
  if (a.reached && hasSubstance) return { accept: true, reason_code: "reframe:accepted" };
  if (!a.reached) return { accept: false, reason_code: "reframe:not-reached" };
  if (a.skipped_planned_retrieval) return { accept: false, reason_code: "reframe:skipped-planned-retrieval" };
  if (a.only_raw_input) return { accept: false, reason_code: "reframe:raw-input-only" };
  return { accept: false, reason_code: "reframe:punt-only" };
}
