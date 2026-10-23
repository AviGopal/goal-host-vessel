/**
 * A REFUSED DISPATCH IS DECLINED, NOT FAILED (design ruling: outcomes are reached / failed / DECLINED; a declined
 * outcome carries its reason as a shaped, queryable impulse).
 *
 * The walk's satisfier decline (judge.satisfierDeclineClass, written inline at the durable persist) already tags its
 * trace declined:<class> with metadata.decline { class, reason_text, decliner_id }, which activity-api's
 * isReachInapplicable reads to neither credit nor blame the row. The dispatch's other refusals did not: the
 * secret-extraction gate answered status failed, reached false and persisted no row, and a needs_information outcome
 * lived only on the in-memory dispatch record, its failed-walk row reading as a failure. The spend-rate breaker's
 * refusal is NOT a decline: it is a front-door throttle, logged and counted where it fires, and writes no trace row.
 *
 * This is the same contract for those refusals, read from the dispatch's own structural outcome (never from goal
 * text): a `refused` outcome (other than spend_rate) declines with its refuse_class, a `needs_information` outcome
 * with the same class the satisfier decline uses. A `non_attempt` (a compose lane's capacity verdict) is not a refusal
 * and stays as it is.
 */
import { questionFor, type NeedsInformationOutcome } from "./needs-information";

/** The structural outcome a dispatch can end with (index.ts DispatchOutcome). */
export type RefusalOutcome =
  | { kind: "non_attempt" | "refused"; failure_kind?: string; refuse_class?: string; retry_after_s?: number }
  | NeedsInformationOutcome;

/** A dispatch-level decline: its class (the declined:<class> trace tag), the reason, and who declined. */
export interface RefusalDecline { class: string; reason: string; decliner_id: string }

/** The decline a dispatch's outcome states, or null when the outcome is not a refusal. */
export function declineOfOutcome(outcome: RefusalOutcome | null | undefined, reasonText?: string | null): RefusalDecline | null {
  if (!outcome) return null;
  if (outcome.kind === "refused") {
    // The spend-rate breaker is a front-door throttle (a 429), not an execution outcome: a row per throttled dispatch
    // would be routine telemetry, which the trace store does not carry, and it would flood while the breaker is tripped.
    if (outcome.refuse_class === "spend_rate") return null;
    const cls = typeof outcome.refuse_class === "string" && /^[a-z0-9_]{1,64}$/.test(outcome.refuse_class) ? outcome.refuse_class : "refused";
    return { class: cls, reason: String(reasonText ?? "").slice(0, 600), decliner_id: `goal-host:refusal:${cls}` };
  }
  if (outcome.kind === "needs_information") {
    return { class: "needs_information", reason: questionFor(outcome).slice(0, 600), decliner_id: "goal-host:walk" };
  }
  return null;
}

/** A trace's tags with the decline's declined:<class> tag, in the same shape the walk's satisfier decline writes. */
export function declinedTags(tags: readonly string[], d: RefusalDecline | null): string[] {
  if (!d) return [...tags];
  return [...tags.filter((t) => !t.startsWith("declined:")), `declined:${d.class}`];
}

/** The metadata fields a decline adds (metadata.decline), or none. */
export function declineMetadata(d: RefusalDecline | null): { decline?: { class: string; reason_text: string; decliner_id: string } } {
  return d ? { decline: { class: d.class, reason_text: d.reason, decliner_id: d.decliner_id } } : {};
}
