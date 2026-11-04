// AN ADMISSION REFUSAL IS FINAL (slice G revision, 2026-10-08). feature_compose refuses some composes at ADMISSION,
// before any slot, envelope or draft: the gap is not compose work, is held, or (check supply) its ledger cannot be
// verified. Escalating such a refusal to patch_with_tools hands the same edit to a lane with no admission of its own
// (no eligibility, hold or check_supply read) that lands through a mitosis tick, so the refusal would only change
// which lane lands it. Read the STRUCTURED stage of the compose report, never its error text.
//
// The stages are development-vessel resolveFeatureCompose's admission refusals. Capacity refusals (budget,
// gap_in_flight, guard, capacity, landing_lease_*) are BUSY and stopped by the routes' existing BUSY handling; plan
// and spec scope refusals (scope) are not admission and keep their existing escalation.
export const ADMISSION_REFUSAL_STAGES: readonly string[] = [
  "input",
  "hold_state_unreadable",
  "operator_hold",
  "ineligible",
  "check_supply_ledger_unreadable",
  "check_supply_gap_missing",
];

/** The refuse_class prefix only the two admission returns in index.ts set: "admission_<stage>" (an underscore, not a
 *  colon, so refusal-decline.ts keeps it as the decline class). No judged refusal carries it. */
export const ADMISSION_REFUSE_CLASS_PREFIX = "admission_";

/**
 * THE NON-ATTEMPT ALLOWLIST: the dispatch outcomes (index.ts DispatchOutcome, CHANGE-30) that walk-complete leaves
 * ungraded, with no evict and no failure lesson, because nothing was produced to judge. It is explicit, never keyed on
 * kind alone: kind "refused" also carries secret_extraction, a deliberate and permanent judgement on the goal's content,
 * which keeps its tombstone and lesson, as does any refuse_class not named here.
 * - kind "non_attempt" (composeNonAttemptOutcome): the compose lane answered BUSY / DRAINING / CAPACITY, or the landing
 *   was deferred by lane state (failure_kind environment). Its refuse_class is the deferring cutover's lane state (gap
 *   store unavailable, landing lease not held, a deferred change window), never a verdict.
 * - refused / "spend_rate": the front-door breaker throttled the dispatch before any LLM call.
 * - refused / "admission_<stage>", stage in ADMISSION_REFUSAL_STAGES: feature_compose refused before any slot or draft.
 */
export function isNonAttemptOutcome(outcome: { kind?: unknown; refuse_class?: unknown } | null | undefined): boolean {
  if (!outcome) return false;
  if (outcome.kind === "non_attempt") return true;
  if (outcome.kind !== "refused" || typeof outcome.refuse_class !== "string") return false;
  if (outcome.refuse_class === "spend_rate") return true;
  const c = outcome.refuse_class;
  return c.startsWith(ADMISSION_REFUSE_CLASS_PREFIX) && ADMISSION_REFUSAL_STAGES.includes(c.slice(ADMISSION_REFUSE_CLASS_PREFIX.length));
}

/** The admission stage a compose report was refused at, or null when it was not refused at admission. */
export function composeAdmissionRefusal(body: Record<string, unknown> | null | undefined): string | null {
  if (!body || body["ok"] === true) return null;
  const verdict = String(body["verdict"] ?? "");
  if (verdict !== "REFUSED" && verdict !== "BUSY") return null;
  const stage = body["stage"];
  return typeof stage === "string" && ADMISSION_REFUSAL_STAGES.includes(stage) ? stage : null;
}
