// THE GAP A COMPOSE IS ATTRIBUTED TO. Every compose-attribution site of the edit-intent route (the two feature_compose
// pointers and the landed-commit probes that grep the commit's `Gap:` trailer) must agree on one id, so they all ask
// composeGapIdOf.
import { goalHashOf, isGapInvestigationGoal } from "./goal-target-inference";

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

/**
 * THE GAP ID IS A STRUCTURED FIELD, RECOVERED FROM TEXT IN ONE PLACE ONLY (qa ruling on the gap
 * gap-goals-carry-their-gap-id-only-in-prose-…). The builders that know the gap send it as variables.decompose_gap_id;
 * a goal that reads as a gap investigation and arrives without it gets ONE exact lookup at admission: each of the
 * goal's own tokens (surrounding punctuation stripped) is read from the gap store by id, in goal order, and the first
 * one the store holds is written into the field. No phrase regex: a reworded goal and an id the anchored parse refuses
 * ('|' in auto-bridged ids) are found the same way. Only an investigation is scanned: the field means "the gap to
 * decompose", so stamping it on a Close/edit goal would re-grade that goal as an investigation. An unreadable store
 * ends the scan (nothing written); every step downstream reads only the field.
 */
export function gapIdTokensOf(goal: string): string[] {
  const out: string[] = [];
  for (const raw of goal.split(/\s+/)) {
    const t = raw.replace(/^["'`(\[{<]+/, "").replace(/["'`)\]}>,;:.!?]+$/, "");
    for (const c of t === raw ? [t] : [t, raw]) if (c.length > 0 && !out.includes(c)) out.push(c);
  }
  return out;
}
export async function recoverGapIdAtAdmission(
  goal: string,
  variables: Record<string, unknown>,
  deps: { readGap: (id: string) => Promise<{ id?: string } | null>; observe: (gapId: string) => void; unreadable?: (e: unknown) => void },
): Promise<string | null> {
  if (typeof variables["decompose_gap_id"] === "string" && variables["decompose_gap_id"].length > 0) return null;
  if (!isGapInvestigationGoal(goal)) return null;
  for (const tok of gapIdTokensOf(goal)) {
    let row: { id?: string } | null;
    try { row = await deps.readGap(tok); } catch (e) { deps.unreadable?.(e); return null; }
    if (row && row.id === tok) {
      variables["decompose_gap_id"] = tok;
      deps.observe(tok);
      return tok;
    }
  }
  return null;
}

/**
 * IS THIS DISPATCH A GAP INVESTIGATION, AND OF WHICH GAP — from the FIELD only. A structured decompose_gap_id selects
 * the gap-investigation oracle (a reworded goal included); a goal that only reads as one is `investigation` with gapId
 * null: graded on the normal path, and observed as gap_id_field_missing. The goal text is never parsed for an id here.
 */
export function gapIdForGrading(goal: string, field: unknown): { investigation: boolean; gapId: string | null } {
  if (typeof field === "string" && field.length > 0) return { investigation: true, gapId: field };
  return { investigation: isGapInvestigationGoal(goal), gapId: null };
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

/**
 * THE DISPATCH ID A CHECK-SUPPLY DISPATCH CARRIES IS THE ONE GOAL-HOST MINTED (slice G revision R2). /run-goal keeps a
 * caller-supplied variables.dispatch_id (parent dispatches pass theirs), so a caller that pre-set the ledger's id with
 * check_supply:true could replay admission for a dispatch the supply already made. With check_supply === true the
 * minted id wins; where none is minted (/resolve: the supply never dispatches there) the marker is dropped. Without
 * check_supply the rule is unchanged: an absent dispatch_id is set to the minted one, a present one is kept.
 */
export function bindCheckSupplyDispatchId(variables: Record<string, unknown>, minted: string | null): void {
  if (variables["check_supply"] === true) {
    if (minted) variables["dispatch_id"] = minted;
    else delete variables["check_supply"];
    return;
  }
  if (minted && !("dispatch_id" in variables)) variables["dispatch_id"] = minted;
}
