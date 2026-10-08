// THE GAP A COMPOSE IS ATTRIBUTED TO. Every compose-attribution site of the edit-intent route (the two feature_compose
// pointers and the landed-commit probes that grep the commit's `Gap:` trailer) must agree on one id, so they all ask
// composeGapIdOf.
import { goalHashOf } from "./goal-target-inference";

// GAP ID OF A GOAL (contained-self-development, gap supply step 0). A compose is attributed to the
// gap its goal names. Only "Close substrate gap X:" was recognised, so gap-to-feature's own
// investigation dispatches ("investigate and decompose gap X: …", "investigate gap X before
// composing …") were minted as fresh `route-edit-<hash>` gaps: 593 open on 2026-09-27, 384 of
// them investigation outputs (4 closed, 0 with a falsifier), each failing, narrowing and being
// investigated again under a new hash. Attributing them to the parent X keeps the work, its
// failures and its closure on the gap that asked for it.
export function gapIdOfGoalText(goal: string): string {
  const m = /^Close substrate gap ([-\w:.!]+):\s/.exec(goal)
    ?? /^investigate and decompose gap ([-\w:.!]+):\s/i.exec(goal)
    ?? /^investigate gap ([-\w:.!]+) before composing\b/i.exec(goal);
  return m?.[1] ?? `route-edit-${goalHashOf(goal)}`;
}

/** The structured marker feature_compose verifies against the gap's check_supply ledger. */
export type CheckSupplyRoute = { gap_id: string; dispatch_id: string };

/**
 * A TEST-WRITING GOAL FROM THE CHECK SUPPLY (slice G, 2026-10-08). development-vessel's gap-check-supply dispatches
 * its test-writing goal with STRUCTURED variables { gap_id, check_supply: true } and records the dispatchId /run-goal
 * returns in the gap's ledger (classification_metadata.check_supply.dispatch_id); /run-goal puts that same id in
 * variables.dispatch_id. Composing under a text-derived route-edit-<hash> id instead minted a new unarmed row and lost
 * the supply's gap (24 dispatches, 0 reached). Only the structured fields count — never goal text — and this is an
 * attribution, not an authority: feature_compose admits the compose only when the gap's own ledger names this dispatch.
 */
export function checkSupplyRouteOf(variables: Record<string, unknown> | undefined): CheckSupplyRoute | null {
  if (!variables || variables["check_supply"] !== true) return null;
  const gapId = variables["gap_id"];
  const dispatchId = variables["dispatch_id"];
  if (typeof gapId !== "string" || !/^[-\w:.!]{1,200}$/.test(gapId)) return null;
  if (typeof dispatchId !== "string" || dispatchId.length === 0) return null;
  return { gap_id: gapId, dispatch_id: dispatchId };
}

/** The gap id a compose of this goal is attributed to: the check supply's gap when it dispatched the goal, else the goal text's. */
export function composeGapIdOf(goal: string, variables: Record<string, unknown> | undefined): string {
  return checkSupplyRouteOf(variables)?.gap_id ?? gapIdOfGoalText(goal);
}
