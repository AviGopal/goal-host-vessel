// A GOAL THAT FORBIDS EVERY CHANGE IS NEVER HANDED TO A LANDING COMPOSE (a-negated-edit-instruction-is-routed-to-a-
// landing-compose; user ruling 2026-10-17T00:00:17Z, with canonicalization). Measured: the early hand-off (decideHandoff,
// and the floor's copy) tested a bare edit verb plus a file path and returned feature_compose with land:true; the edit
// verb sat INSIDE the clause forbidding it, and goal-intent's prohibitsAnyMutation was never read on that route. No
// structural guard between that route and a landing held. Typography also defeated the predicate: "don’t" ≠ "don't".
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { handoffRoute } from "../src/routing-core/entries";
import { floorHandoff } from "../src/routing-core/floor";
import { canonicalGoalText, isEditIntentGoal, prohibitsAnyMutation } from "../src/goal-intent";

const READ_ONLY = [
  "Read repos/widget-vessel/src/ledger.ts and report which categories the widget ledger defines. Do not change anything.",
  "Report what repos/parcel-vessel/src/depot.ts keeps per destination region in the depot store; don't edit or update any file.",
  "Look through repos/widget-vessel/src/ledger.ts and the widget ledger store and tell me how categories are assigned. Never add, remove or modify anything.",
  // PARAPHRASE (typography): the same prohibition typed with a curly apostrophe (U+2019).
  "Report what repos/parcel-vessel/src/depot.ts keeps per destination region; don’t edit or update any file.",
];
const EDITS = [
  "Edit repos/widget-vessel/src/ledger.ts to add a colour field to the widget record.",
  "Fix the rounding in repos/parcel-vessel/src/depot.ts without changing its public API.",
  // CONTROL (typography): an edit request typed with curly quotes still composes.
  "Edit repos/widget-vessel/src/ledger.ts so the “colour” field defaults to ‘none’.",
];
const route = (goal: string) => handoffRoute({ goal_for_routing: goal, route_enabled: true });

describe("the early hand-off and a goal that forbids every change", () => {
  for (const g of READ_ONLY) {
    it(`[MUST-FAIL] routes to the walk, not feature_compose — ${g.slice(0, 70)}…`, () => {
      expect(route(g)?.route ?? "walk").toBe("walk");
      expect(floorHandoff({ goal_for_routing: g, route_enabled: true }).route).toBe("walk");
    });
  }
  for (const g of EDITS) {
    it(`[CONTROL] a genuine edit still composes onto its file — ${g.slice(0, 70)}…`, () => {
      expect(route(g)).toEqual({ route: "feature_compose", target: g.match(/repos\/[\w.\/-]+\.\w+/)![0] });
      expect(floorHandoff({ goal_for_routing: g, route_enabled: true }).route).toBe("feature_compose");
    });
  }
  it("[HELD-OUT] the curly-apostrophe prohibition is recognised by the shared predicate too (not only by the router)", () => {
    expect(prohibitsAnyMutation(READ_ONLY[3]!)).toBe(true);
    expect(isEditIntentGoal(READ_ONLY[3]!)).toBe(false);
  });
});

describe("canonicalGoalText: one definition", () => {
  it("[UNIT] folds typographic quotes and compatibility forms; idempotent; plain ASCII unchanged", () => {
    expect(canonicalGoalText("don’t “x” Ａ b")).toBe("don't \"x\" A b");
    const g = "Edit repos/a-vessel/src/x.ts — keep ‘y’";
    expect(canonicalGoalText(canonicalGoalText(g))).toBe(canonicalGoalText(g));
    expect(canonicalGoalText("Fix repos/a/src/b.ts now.")).toBe("Fix repos/a/src/b.ts now.");
  });
  it("[WIRING] /run-goal canonicalizes once at ingress; the rules and the floor read the shared predicate", () => {
    const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(idx).toContain('const rawGoal = typeof body.goal === "string" ? canonicalGoalText(body.goal) : undefined;');
    for (const f of ["../src/routing-rules/edit-intent.ts", "../src/routing-core/floor.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src).toContain("const g = canonicalGoalText(input.goal_for_routing);\n  if (prohibitsAnyMutation(g)) return { route: \"walk\", target: null };");
    }
  });
});
