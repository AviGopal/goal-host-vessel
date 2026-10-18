// A GOAL THAT FORBIDS EVERY CHANGE IS NEVER HANDED TO A LANDING COMPOSE (a-negated-edit-instruction-is-routed-to-a-
// landing-compose; user ruling 2026-10-17T00:00:17Z, with canonicalization). Measured: the early hand-off (decideHandoff,
// and the floor's copy) tested a bare edit verb plus a file path and returned feature_compose with land:true; the edit
// verb sat INSIDE the clause forbidding it, and goal-intent's prohibitsAnyMutation was never read on that route. No
// structural guard between that route and a landing held. Typography also defeated the predicate: "don’t" ≠ "don't".
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { handoffRoute } from "../src/routing-core/entries";
import { floorHandoff } from "../src/routing-core/floor";
import { canonicalGoalText, goalDemandsLandedEdit, isEditIntentGoal, prohibitsAnyMutation } from "../src/goal-intent";
import { goalAsksForChange } from "../src/judge-rules/write-goal";

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
// ZERO-OVERLAP PARAPHRASES (a-goal-not-admitted-as-a-change-still-runs-non-filesystem-write-shapes-inside-composed-templates;
// user ruling "Keep wording-based routing"): a description request under a change prohibition phrased in none of
// prohibitsAnyMutation's forms, each carrying an edit verb the hand-off reads (so each composes on the parent).
// Measured: the first went to feature_compose and drafted a real edit.
const DESCRIBE_UNDER_PROHIBITION = [
  "Leave the file untouched and tell me what would change in repos/goal-host-vessel/src/edge-blend.ts to make its blend weights configurable.",
  "Read-only pass: tell me what you would add to repos/goal-host-vessel/src/edge-blend.ts to support a second blend mode.",
  "Without touching anything, explain how you would refactor repos/goal-host-vessel/src/edge-blend.ts to expose its weights.",
];
// CONTROLS: no edit verb the hand-off or the detectors read, so they walk on every tree (they did on the parent too).
const DESCRIBE_WITHOUT_EDIT_VERB = [
  "read-only please: what would repos/goal-host-vessel/src/edge-blend.ts need to support a second blend mode?",
  "without touching anything, describe how repos/goal-host-vessel/src/edge-blend.ts could expose its weights",
];
// A QUALIFIER SCOPES AN EDIT, IT DOES NOT PROHIBIT ONE ("without changing its signature", "callers stay unchanged",
// "keeping the API unchanged", "without altering its return type"): each is a real edit. Measured on the predicate's
// first form, every one flipped to the walk or lost its landed-edit demand, so it could reach on prose with no edit.
// `compose`: the hand-off's own verb list carries it to feature_compose (as on the parent); the rest walk there but
// still demand a landed edit.
const SCOPED_EDITS: Array<{ goal: string; compose: boolean }> = [
  { goal: "Could you add a null check to repos/goal-host-vessel/src/edge-blend.ts without changing its signature?", compose: true },
  { goal: "Can you fix the off-by-one in repos/goal-host-vessel/src/edge-blend.ts so existing callers stay unchanged?", compose: true },
  { goal: "Ensure repos/goal-host-vessel/src/edge-blend.ts rejects negative weights without changing the exports; explain the change.", compose: true },
  { goal: "Implement retry with backoff in repos/goal-host-vessel/src/edge-blend.ts, keeping the API unchanged, and report what you did.", compose: false },
  { goal: "Extend parseWeight in repos/goal-host-vessel/src/edge-blend.ts to accept percentages without altering its return type, then summarise what you did.", compose: false },
  // "read-only" as an adjective of the edit's object, not a mode of the request.
  { goal: "Make the cache field read-only in repos/goal-host-vessel/src/edge-blend.ts and explain the change.", compose: true },
  // BOUNDARY: "anything ELSE" scopes; only an unqualified "anything" prohibits.
  { goal: "Fix the clamp in repos/goal-host-vessel/src/edge-blend.ts without changing anything else; explain what you did.", compose: true },
];
const EDITS_UNDER_DESCRIPTION = [
  "Edit repos/goal-host-vessel/src/edge-blend.ts to make its blend weights configurable",
  // CONTROL: a real edit that also asks for a report and names a constraint on change still composes.
  "Fix the rounding in repos/parcel-vessel/src/depot.ts without changing its public API, then report what changed.",
];

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
  for (const g of DESCRIBE_UNDER_PROHIBITION) {
    it(`[MUST-FAIL] a description request under a change prohibition walks — ${g.slice(0, 70)}…`, () => {
      expect(route(g)?.route ?? "walk").toBe("walk");
      expect(floorHandoff({ goal_for_routing: g, route_enabled: true }).route).toBe("walk");
    });
  }
  for (const g of DESCRIBE_UNDER_PROHIBITION) {
    it(`[MUST-FAIL] the late detectors agree: not an edit intent, no landed edit demanded — ${g.slice(0, 60)}…`, () => {
      expect(isEditIntentGoal(g)).toBe(false);
      expect(goalDemandsLandedEdit(g)).toBe(false);
    });
  }
  for (const g of DESCRIBE_WITHOUT_EDIT_VERB) {
    it(`[CONTROL] a description request with no edit verb walks and is no edit — ${g.slice(0, 60)}…`, () => {
      expect(route(g)?.route ?? "walk").toBe("walk");
      expect(floorHandoff({ goal_for_routing: g, route_enabled: true }).route).toBe("walk");
      expect(isEditIntentGoal(g)).toBe(false);
      expect(goalDemandsLandedEdit(g)).toBe(false);
    });
  }
  for (const { goal: g, compose } of SCOPED_EDITS) {
    it(`[CONTROL] a scoping qualifier is not a prohibition: the edit routes and demands a landed edit — ${g.slice(0, 60)}…`, () => {
      expect(goalDemandsLandedEdit(g)).toBe(true);
      expect(goalAsksForChange(g)).toBe(true);
      if (compose) {
        expect(route(g)).toEqual({ route: "feature_compose", target: g.match(/repos\/[\w.\/-]+\.\w+/)![0] });
        expect(floorHandoff({ goal_for_routing: g, route_enabled: true }).route).toBe("feature_compose");
        expect(isEditIntentGoal(g)).toBe(true);
      }
    });
  }
  it("[WIRING] the late edit-intent route declines a goal that forbids change, before it composes", () => {
    const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const decl = idx.indexOf("const lateRouteForbidden = !!fileMatch && (prohibitsAnyMutation(goal) || asksForDescriptionUnderChangeProhibition(goal));");
    expect(decl).toBeGreaterThan(0);
    const branch = idx.indexOf("if (fileMatch && !lateRouteForbidden) {", decl);
    expect(branch).toBeGreaterThan(decl);
    expect(branch - decl).toBeLessThan(400);
  });
  for (const g of EDITS_UNDER_DESCRIPTION) {
    it(`[CONTROL] a real edit still composes onto its file — ${g.slice(0, 70)}…`, () => {
      expect(route(g)).toEqual({ route: "feature_compose", target: g.match(/repos\/[\w.\/-]+\.\w+/)![0] });
      expect(floorHandoff({ goal_for_routing: g, route_enabled: true }).route).toBe("feature_compose");
      expect(isEditIntentGoal(g)).toBe(true);
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
