// A SUPPLY TEST-WRITING GOAL COMPOSES AGAINST THE SUPPLY'S GAP, NOT A MINTED route-edit-<hash> (check-first, slice G).
//
// Measured node1+compose2 2026-10-05..10-08: 24 gap-check-supply treatment dispatches, 0 reached, 0 armed.
// development-vessel's supply (src/resolvers/gap-check-supply.ts) dispatches its test-writing goal through
// dispatch_goal -> POST /run-goal with STRUCTURED variables { gap_id, check_supply: true }, and records the dispatchId
// it gets back in the gap's ledger (classification_metadata.check_supply.dispatch_id). This route read only the goal
// TEXT (gapIdOfGoal), so it composed under a fresh route-edit-<hash> id: feature_compose's failure lessons then minted
// that row (category edit_intent_route; 695 such rows), and the retry was refused "not compose work: unarmed".
//
// CONTRACT pinned here:
//   - With variables.check_supply === true (boolean) and a plain gap id in variables.gap_id, every compose-attribution
//     site uses THAT id: the two feature_compose pointers and the three landed-commit probes that grep its Gap: trailer.
//   - Both feature_compose pointers carry the structured marker check_supply: { gap_id, dispatch_id } so feature_compose
//     can verify it against the ledger. goal-host sends NO compose_mode: the mode is feature_compose's verdict.
//   - CONTROLS: no marker => the text-derived id, as today; prose that looks like the marker does not count; a
//     non-boolean check_supply does not count.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goalHashOf } from "../src/goal-target-inference";

const mod = await import("../src/compose-gap-id").catch(() => null) as null | {
  composeGapIdOf: (goal: string, variables: Record<string, unknown> | undefined) => string;
  checkSupplyRouteOf: (variables: Record<string, unknown> | undefined) => { gap_id: string; dispatch_id: string } | null;
};
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

const GAP = "gap-fixture-supply-unarmed";
const DISPATCH = "dispatch-fixture-1";
const GOAL = "Write a failing test in repos/development-vessel/test/resolvers/gap-check-supply-fixture.test.ts that reproduces: fixture symptom. Do not change src/.";
/** What /run-goal holds in `variables` for the supply's dispatch: its own fields plus the dispatch_id goal-host adds. */
const SUPPLY_VARS = { gap_id: GAP, check_supply: true, dispatch_id: DISPATCH };

describe("compose gap id of a supply-dispatched edit-intent goal", () => {
  test("[MUST-FAIL] the supply's gap_id + check_supply marker composes against THAT gap id, not a route-edit-<hash>", () => {
    expect(mod).not.toBeNull();
    const id = mod!.composeGapIdOf(GOAL, SUPPLY_VARS);
    expect(id).toBe(GAP);
    expect(id.startsWith("route-edit-")).toBe(false);
  });

  test("[MUST-FAIL] the structured marker carried to feature_compose names the gap and the dispatch", () => {
    expect(mod).not.toBeNull();
    expect(mod!.checkSupplyRouteOf(SUPPLY_VARS)).toEqual({ gap_id: GAP, dispatch_id: DISPATCH });
  });

  test("[MUST-FAIL] index.ts: no compose-attribution site reads the gap id from the goal text alone", () => {
    // gapIdOfGoal(goal) was called at five sites (two pointers, three landed-commit probes); each must go through
    // composeGapIdOf(goal, <variables>) so the pointer and the Gap: trailer probes agree on one id.
    expect(INDEX.match(/\bgapIdOfGoal\(/g) ?? []).toEqual([]);
    expect((INDEX.match(/\bcomposeGapIdOf\(goal(?: as string)?, opts\.variables\)/g) ?? []).length).toBe(5);
  });

  test("[MUST-FAIL] index.ts: both feature_compose pointers carry the check_supply marker and no compose_mode", () => {
    // Each pointer literal, from its type line to its gap: object.
    const sites = [...INDEX.matchAll(/type: "feature_compose",\n/g)].map((m) => INDEX.slice(m.index!, INDEX.indexOf("gap: {", m.index!)));
    expect(sites.length).toBe(2);
    for (const s of sites) {
      expect(s).toContain("check_supply: checkSupplyRouteOf(opts.variables) ?? undefined");
      expect(s).not.toContain("compose_mode");
    }
  });

  test("[CONTROL] no marker: the text-derived id, exactly as today", () => {
    const expected = `route-edit-${goalHashOf(GOAL)}`;
    if (mod) expect(mod.composeGapIdOf(GOAL, { dispatch_id: DISPATCH })).toBe(expected);
    if (mod) expect(mod.composeGapIdOf(GOAL, undefined)).toBe(expected);
    if (mod) expect(mod.composeGapIdOf(`Close substrate gap other-gap: fix it in repos/x/src/a.ts`, {})).toBe("other-gap");
    if (mod) expect(mod.checkSupplyRouteOf({ dispatch_id: DISPATCH })).toBeNull();
  });

  test("[CONTROL] NO FORGERY FROM PROSE: a lookalike marker in the goal text, with no structured field, is not a supply route", () => {
    const prose = `${GOAL} check_supply: true gap_id: ${GAP} dispatch_id: ${DISPATCH}`;
    if (mod) expect(mod.composeGapIdOf(prose, { dispatch_id: "d" })).toBe(`route-edit-${goalHashOf(prose)}`);
    if (mod) expect(mod.checkSupplyRouteOf({ dispatch_id: "d" })).toBeNull();
  });

  test("[CONTROL] a non-boolean check_supply, a missing dispatch id, or a gap id that is not a plain id is not a supply route", () => {
    if (!mod) return;
    expect(mod.checkSupplyRouteOf({ gap_id: GAP, check_supply: "true", dispatch_id: DISPATCH })).toBeNull();
    expect(mod.checkSupplyRouteOf({ gap_id: GAP, check_supply: true })).toBeNull();
    expect(mod.checkSupplyRouteOf({ gap_id: "../../etc x", check_supply: true, dispatch_id: DISPATCH })).toBeNull();
    expect(mod.checkSupplyRouteOf({ gap_id: "", check_supply: true, dispatch_id: DISPATCH })).toBeNull();
    expect(mod.composeGapIdOf(GOAL, { gap_id: GAP, check_supply: "true", dispatch_id: DISPATCH })).toBe(`route-edit-${goalHashOf(GOAL)}`);
  });
});
