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

/** The admission stage a compose report was refused at, or null when it was not refused at admission. */
export function composeAdmissionRefusal(body: Record<string, unknown> | null | undefined): string | null {
  if (!body || body["ok"] === true) return null;
  const verdict = String(body["verdict"] ?? "");
  if (verdict !== "REFUSED" && verdict !== "BUSY") return null;
  const stage = body["stage"];
  return typeof stage === "string" && ADMISSION_REFUSAL_STAGES.includes(stage) ? stage : null;
}
