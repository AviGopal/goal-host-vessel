// THE EDIT-INTENT ROUTE SWITCH IS A SHAPED RECORD (src/edit-intent-route.ts), NOT AN ENV VAR.
//
// The switch is the activityVariantMask pool row for goal-host-vessel:edit-intent-route, read once per dispatch:
// variant 0 / no row / unreadable pool = route to feature_compose as before; variant 1 = no feature_compose hand-off,
// the dispatch is admitted as a change and walks toward the landing shape (cutoverApplied). A walk step whose output
// already landed in process (patch_with_tools: landed:true / new_git_sha) satisfies that target, so no second landing
// step is sought.
//
// Seam: index.ts boots the vessel on import, so (as check-supply-missed-edit-route.test.ts) the dispatch cannot be
// driven end to end here. The decisions are tested on the smallest exported functions that make them
// (editIntentRouteDecision, the routing core's handoffRoute, withLandingTarget, landingSatisfiedBy, the write-door
// predicates), and their wiring in index.ts is pinned as text by anchor.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { editIntentRouteDecision, editIntentRouteLine, EDIT_INTENT_ROUTE_ACTIVITY, inProcessLanding, LANDING_TARGET_SHAPE, landingSatisfiedBy, withLandingTarget } from "../src/edit-intent-route";
import { handoffRoute } from "../src/routing-core/entries";
import { isFsWriteShape } from "../src/fs-write-shapes";
import { refusedWrite } from "../src/write-door";

const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
const NOW = new Date().toISOString(); // the dispatch reads the record at its own now
const FROM = "2000-01-01T00:00:00.000Z";
const UNTIL = "2099-01-01T00:00:00.000Z";
const mask = (active_variant: unknown, over: Record<string, unknown> = {}) =>
  [{ id: "mask-edit-intent-route", body: { activity_id: EDIT_INTENT_ROUTE_ACTIVITY, active_variant, from: FROM, until: UNTIL, reason: "fixture", by: "operator", ...over } }];
const EDIT_GOAL = "Fix the off-by-one in repos/goal-host-vessel/src/edit-intent-route.ts so the window end is exclusive.";

/** Brace depth of `to` relative to `from` in index.ts, skipping comments and string/template text. */
function braceDepth(from: number, to: number): number {
  let depth = 0;
  let quote: string | null = null;
  const tmpl: number[] = [];
  for (let i = from; i < to; i++) {
    const c = INDEX[i]!;
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (quote === "`" && c === "$" && INDEX[i + 1] === "{") { tmpl.push(depth); depth++; quote = null; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && INDEX[i + 1] === "/") { const nl = INDEX.indexOf("\n", i); i = nl < 0 ? to : nl; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (tmpl.length && depth === tmpl[tmpl.length - 1]) { tmpl.pop(); quote = "`"; } }
  }
  return depth;
}
const at = (s: string, from = 0): number => INDEX.indexOf(s, from);
const EARLY_IF = 'if (earlyHandoff.route === "feature_compose" && earlyHandoff.target) {';
const LATE_IF = "if (_editIntentRoute.route_enabled) {";

describe("[CONTROL] variant 0, no record, an unreadable pool: route to feature_compose exactly as before", () => {
  test("variant 0 in force", () => {
    const d = editIntentRouteDecision(NOW, mask(0));
    expect(d).toMatchObject({ variant: 0, route_enabled: true, mask_id: "mask-edit-intent-route", mask_state: "in_force" });
  });
  test("no record for this activity, or none whose [from, until) holds now", () => {
    for (const rows of [[], mask(1, { activity_id: "goal-host:failure-recall" }), mask(1, { until: FROM }), mask(1, { from: UNTIL })]) {
      expect(editIntentRouteDecision(NOW, rows)).toMatchObject({ variant: 0, route_enabled: true, mask_id: null, mask_state: "no_mask" });
    }
  });
  test("unreadable pool", () => {
    expect(editIntentRouteDecision(NOW, null)).toMatchObject({ variant: 0, route_enabled: true, mask_state: "unread" });
  });
  test("unknown variant is variant 0", () => {
    for (const v of [7, "1", null]) expect(editIntentRouteDecision(NOW, mask(v))).toMatchObject({ variant: 0, route_enabled: true, mask_state: "in_force" });
  });
  test("route enabled: the routing core hands the edit goal to feature_compose", () => {
    const h = handoffRoute({ goal_for_routing: EDIT_GOAL, route_enabled: editIntentRouteDecision(NOW, mask(0)).route_enabled });
    expect(h.route).toBe("feature_compose");
    expect(h.target).toBe("repos/goal-host-vessel/src/edit-intent-route.ts");
  });
  test("the decision line names mask id, state and why", () => {
    const line = editIntentRouteLine("run-goal", editIntentRouteDecision(NOW, null));
    expect(line).toContain("edit-intent-route variant=0 route=feature_compose");
    expect(line).toContain('"mask_state":"unread"');
    expect(line).toContain('"mask_id":null');
  });
});

describe("[MUST-FAIL] variant 1: no feature_compose hand-off; the goal is admitted as a change and targets cutoverApplied", () => {
  test("variant 1 in force disables the route", () => {
    const d = editIntentRouteDecision(NOW, mask(1));
    expect(d).toMatchObject({ variant: 1, route_enabled: false, mask_id: "mask-edit-intent-route", mask_state: "in_force" });
    expect(editIntentRouteLine("run-goal", d)).toContain("route=walk");
  });
  test("the routing core does not hand off with the route disabled, and would with it enabled", () => {
    expect(handoffRoute({ goal_for_routing: EDIT_GOAL, route_enabled: false }).route).not.toBe("feature_compose");
    expect(handoffRoute({ goal_for_routing: EDIT_GOAL, route_enabled: true }).route).toBe("feature_compose");
  });
  test("the walk target gains cutoverApplied, once", () => {
    expect(withLandingTarget(["fileEditResult"])).toEqual(["fileEditResult", LANDING_TARGET_SHAPE]);
    expect(withLandingTarget(undefined)).toEqual([LANDING_TARGET_SHAPE]);
    expect(withLandingTarget([LANDING_TARGET_SHAPE])).toEqual([LANDING_TARGET_SHAPE]);
  });
  test("[MUST-FAIL] variant 1 drops targets the walk can never produce (filesystem writes) and keeps the rest", () => {
    expect(withLandingTarget(["fs_edit", "fileEditResult", "code_replace_lines", "sourceCode"], isFsWriteShape)).toEqual(["sourceCode", LANDING_TARGET_SHAPE]);
    expect(INDEX).toContain("seededOutputShapes = withLandingTarget(seededOutputShapes, isFsWriteShape);");
  });
  test("wiring: no env switch is read; the early check reads the record decided once per dispatch", () => {
    expect(INDEX).not.toContain("process.env.ROUTE_EDIT_INTENT_TO_COMPOSE");
    expect(INDEX).not.toContain('process.env["ROUTE_EDIT_INTENT_TO_COMPOSE"]');
    const decided = at("const _editIntentRoute = editIntentRouteDecision(new Date().toISOString(), await readVariantMasks());");
    const early = at("const earlyEditIntentEnabled = _editIntentRoute.route_enabled;");
    expect(decided).toBeGreaterThan(0);
    expect(early).toBeGreaterThan(decided);
    expect(INDEX.slice(early, early + 400)).toContain("judgeCapture.noteRouteEnabled({ goal: String(goal ?? \"\"), enabled: earlyEditIntentEnabled });");
  });
  test("wiring: the variant-1 block admits the change and seeds cutoverApplied before the walk", () => {
    const block = at("if (!earlyEditIntentEnabled) {");
    const early = at(EARLY_IF);
    expect(block).toBeGreaterThan(0);
    expect(early).toBeGreaterThan(block);
    const body = INDEX.slice(block, early);
    expect(body).toContain("routingHandoff({ goal_for_routing: goalForRouting, route_enabled: true })");
    expect(body).toContain("_changeAdmitted = true;");
    expect(body).toContain("seededOutputShapes = withLandingTarget(seededOutputShapes, isFsWriteShape);");
    expect(body).toContain("noteDispatchedTargets(goal, seededOutputShapes);");
    const walk = at("let walk = await runGoalAsPoolWalk(goal, {");
    expect(walk).toBeGreaterThan(early);
  });
  test("wiring: every feature_compose POST sits inside a route gated by the record (early or late)", () => {
    const early = at(EARLY_IF);
    const late = at(LATE_IF);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(early);
    const posts: number[] = [];
    for (let i = at('type: "feature_compose",'); i >= 0; i = at('type: "feature_compose",', i + 1)) posts.push(i);
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      const inEarly = p > early && p < late && braceDepth(early, p) > 0;
      const inLate = p > late && braceDepth(late, p) > 0;
      expect({ at: p, gated: inEarly || inLate }).toEqual({ at: p, gated: true });
    }
  });
});

describe("[CONTROL] filesystem writes stay refused at vesselResolve", () => {
  test("fs_write is a filesystem-write shape, refused on a goal not admitted", () => {
    expect(isFsWriteShape("fs_write")).toBe(true);
    expect(refusedWrite("fs_write")).toBe(true);
  });
  test("vesselResolve refuses it unconditionally (admitted or not), before the admission door", () => {
    const fs = at("if (isFsWriteShape(shape)) { // = write-door.ts isWriteShape: unconditional, admitted or not");
    const door = at("if (!changeAdmitted && refusedWrite(shape, writeDoorProduct)) {", fs);
    expect(fs).toBeGreaterThan(0);
    expect(door).toBeGreaterThan(fs);
    expect(INDEX.slice(fs, door)).toContain("return null;");
  });
});

describe("[MUST-FAIL] an in-process landing satisfies cutoverApplied, so no second landing step runs", () => {
  const targets = new Set(["fileEditResult", LANDING_TARGET_SHAPE]);
  test("landed:true or a new_git_sha (top level or under body) is a landing", () => {
    expect(inProcessLanding({ landed: true })).toEqual({ landed: true, new_git_sha: null });
    expect(inProcessLanding({ body: { landed: true, new_git_sha: "abc123" } })).toEqual({ landed: true, new_git_sha: "abc123" });
    expect(inProcessLanding({ body: { new_git_sha: "abc123" } }).landed).toBe(true);
  });
  test("a staged, not-landed output is not a landing (the landing step still runs)", () => {
    expect(inProcessLanding({ body: { landed: false } }).landed).toBe(false);
    expect(inProcessLanding({ body: { landed: false, new_git_sha: "" } }).landed).toBe(false);
    expect(landingSatisfiedBy("mitosisStaged", { body: { landed: false } }, targets, new Set(), "pick:development-vessel:patch-with-tools")).toBe(false);
  });
  test("satisfied only when the walk targets cutoverApplied and has not produced it", () => {
    expect(landingSatisfiedBy("mitosisStaged", { body: { landed: true } }, targets, new Set(), "pick:development-vessel:patch-with-tools")).toBe(true);
    expect(landingSatisfiedBy("patch_with_tools", { body: { landed: true } }, targets, new Set(), "pick:development-vessel:patch-with-tools")).toBe(true);
    expect(landingSatisfiedBy("mitosisStaged", { body: { landed: true } }, new Set(["fileEditResult"]), new Set(), "pick:development-vessel:patch-with-tools")).toBe(false);
    expect(landingSatisfiedBy("mitosisStaged", { body: { landed: true } }, targets, new Set([LANDING_TARGET_SHAPE]), "pick:development-vessel:patch-with-tools")).toBe(false);
  });
  test("[MUST-FAIL] a READ step's output that carries landed or new_git_sha is not a landing (no hollow reach)", () => {
    for (const shape of ["cutoverReport", "substrateGap", "executionTrace", "memoryNote", "gitLog", "mitosisPendingState"]) {
      expect({ shape, satisfied: landingSatisfiedBy(shape, { body: { landed: true, new_git_sha: "abc123" } }, targets, new Set(), "pick:development-vessel:patch-with-tools") }).toEqual({ shape, satisfied: false });
    }
  });
  test("[MUST-FAIL] a SEEDED impulse (standing pool or caller variable) that carries a landing is not this dispatch's landing", () => {
    const landed = { body: { landed: true, new_git_sha: "abc123" } };
    expect(landingSatisfiedBy("mitosisStaged", landed, targets, new Set(), "seed")).toBe(false);
    expect(landingSatisfiedBy("mitosisStaged", landed, targets, new Set(), undefined)).toBe(false);
    expect(landingSatisfiedBy("mitosisStaged", landed, targets, new Set(), "satisfier:patch_with_tools")).toBe(true);
  });
  test("after the guard, the missing-target set the walk picks producers from no longer holds cutoverApplied", () => {
    // The walk's own computation, `[...target].filter((s) => !producedShapes.has(s))`, applied to the pool the guard leaves.
    const produced = new Set<string>(["mitosisStaged"]);
    if (landingSatisfiedBy("mitosisStaged", { body: { landed: true, new_git_sha: "abc123" } }, targets, produced, "pick:development-vessel:patch-with-tools")) produced.add(LANDING_TARGET_SHAPE);
    const missing = [...targets].filter((s) => !produced.has(s));
    expect(missing).not.toContain(LANDING_TARGET_SHAPE);
  });
  test("wiring: the guard sits in addToPool, where targetMet and every missing-target pick read the pool", () => {
    const add = at("const addToPool = (shape: string, content: unknown, summary?: string, prov?: PoolProvenance): void => {");
    expect(add).toBeGreaterThan(0);
    const guard = at("if (shape !== LANDING_TARGET_SHAPE && landingSatisfiedBy(shape, content, writeDoorProduct, producedShapes, prov?.producedBy)) {", add);
    expect(guard).toBeGreaterThan(add);
    expect(braceDepth(add, guard)).toBe(1);
    expect(INDEX.slice(guard, guard + 600)).toContain("addToPool(LANDING_TARGET_SHAPE, { satisfied_by: shape, landed: true, new_git_sha: landing.new_git_sha }");
    expect(INDEX).toContain("const targetMet = (): boolean => target.size > 0 && [...target].every((s) => producedShapes.has(s));");
    // writeDoorProduct (not `target`) because addToPool runs during seeding, before `target` is declared.
    const product = at("const writeDoorProduct = new Set<string>(");
    expect(product).toBeGreaterThan(0);
    expect(product).toBeLessThan(add);
  });
});
