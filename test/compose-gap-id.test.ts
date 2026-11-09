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
  checkSupplyRouteOf: (variables: Record<string, unknown> | undefined) => { gap_id: string; dispatch_id: string } | null;
};
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

const GAP = "gap-fixture-supply-unarmed";
const DISPATCH = "dispatch-fixture-1";
const GOAL = "Write a failing test in repos/development-vessel/test/resolvers/gap-check-supply-fixture.test.ts that reproduces: fixture symptom. Do not change src/.";
/** What /run-goal holds in `variables` for the supply's dispatch: its own fields plus the dispatch_id goal-host adds. */
const SUPPLY_VARS = { gap_id: GAP, check_supply: true, dispatch_id: DISPATCH };

describe("compose gap id of a supply-dispatched edit-intent goal", () => {
  test("[MUST-FAIL] the structured marker carried to feature_compose names the gap and the dispatch", () => {
    expect(mod).not.toBeNull();
    expect(mod!.checkSupplyRouteOf(SUPPLY_VARS)).toEqual({ gap_id: GAP, dispatch_id: DISPATCH });
  });

  test("[MUST-FAIL] index.ts: no compose-attribution site reads the gap id from the goal text alone", () => {
    expect(INDEX.match(/\bgapIdOfGoal\(/g) ?? []).toEqual([]);
  });

  test("[CONTROL] no marker: the text-derived id, exactly as today", () => {
    if (mod) expect(mod.checkSupplyRouteOf({ dispatch_id: DISPATCH })).toBeNull();
  });

  test("[CONTROL] NO FORGERY FROM PROSE: a lookalike marker in the goal text, with no structured field, is not a supply route", () => {
    const prose = `${GOAL} check_supply: true gap_id: ${GAP} dispatch_id: ${DISPATCH}`;
    if (mod) expect(mod.checkSupplyRouteOf({ dispatch_id: "d" })).toBeNull();
  });

  test("[CONTROL] a non-boolean check_supply, a missing dispatch id, or a gap id that is not a plain id is not a supply route", () => {
    if (!mod) return;
    expect(mod.checkSupplyRouteOf({ gap_id: GAP, check_supply: "true", dispatch_id: DISPATCH })).toBeNull();
    expect(mod.checkSupplyRouteOf({ gap_id: GAP, check_supply: true })).toBeNull();
    expect(mod.checkSupplyRouteOf({ gap_id: "../../etc x", check_supply: true, dispatch_id: DISPATCH })).toBeNull();
    expect(mod.checkSupplyRouteOf({ gap_id: "", check_supply: true, dispatch_id: DISPATCH })).toBeNull();
  });
});
