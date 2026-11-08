// A CHANGE GOAL IS WALKED (src/edit-intent-route.ts); THERE IS NO COMPOSE HAND-OFF AND NO SWITCH.
//
// When the edit-intent routing rules name a file to change, the dispatch is admitted as a change and walks toward the
// landing shape (cutoverApplied), unconditionally: no mask or env switch is read, and index.ts POSTs no feature_compose.
// A walk step whose output already landed in process (patch_with_tools: landed:true / new_git_sha) satisfies that
// target, so no second landing step is sought.
//
// Seam: index.ts boots the vessel on import, so the dispatch cannot be driven end to end here. The decisions are tested
// on the smallest exported functions that make them (the routing core's handoffRoute, withLandingTarget,
// landingSatisfiedBy, the write-door predicates), and their wiring in index.ts is pinned as text by anchor.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inProcessLanding, LANDING_TARGET_SHAPE, landingSatisfiedBy, withLandingTarget } from "../src/edit-intent-route";
import { handoffRoute } from "../src/routing-core/entries";
import { isFsWriteShape } from "../src/fs-write-shapes";
import { refusedWrite } from "../src/write-door";

const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
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
const ADMIT_IF = 'if (changeHandoff.route === "feature_compose" && changeHandoff.target) {';

describe("[MUST-FAIL] no compose hand-off: the goal is admitted as a change and targets cutoverApplied", () => {
  test("the routing core names the file to change (its route label is the rules' own decision, not a POST)", () => {
    const h = handoffRoute({ goal_for_routing: EDIT_GOAL, route_enabled: true });
    expect(h.route).toBe("feature_compose");
    expect(h.target).toBe("repos/goal-host-vessel/src/edit-intent-route.ts");
  });
  test("the walk target gains cutoverApplied, once", () => {
    expect(withLandingTarget(["fileEditResult"])).toEqual(["fileEditResult", LANDING_TARGET_SHAPE]);
    expect(withLandingTarget(undefined)).toEqual([LANDING_TARGET_SHAPE]);
    expect(withLandingTarget([LANDING_TARGET_SHAPE])).toEqual([LANDING_TARGET_SHAPE]);
  });
  test("[MUST-FAIL] the landing target drops targets the walk can never produce (filesystem writes) and keeps the rest", () => {
    expect(withLandingTarget(["fs_edit", "fileEditResult", "code_replace_lines", "sourceCode"], isFsWriteShape)).toEqual(["sourceCode", LANDING_TARGET_SHAPE]);
    expect(INDEX).toContain("seededOutputShapes = withLandingTarget(seededOutputShapes, isFsWriteShape);");
  });
  test("[MUST-FAIL] index.ts POSTs no feature_compose and reads no route switch", () => {
    expect(INDEX.split('type: "feature_compose"').length - 1).toBe(0);
    expect(INDEX).not.toContain("process.env.ROUTE_EDIT_INTENT_TO_COMPOSE");
    expect(INDEX).not.toContain('process.env["ROUTE_EDIT_INTENT_TO_COMPOSE"]');
    for (const gone of ["editIntentRouteDecision", "editIntentRouteLine", "_editIntentRoute", "earlyHandoff", "earlyEditIntentEnabled", "EARLY EDIT-INTENT"]) {
      expect({ gone, present: INDEX.includes(gone) }).toEqual({ gone, present: false });
    }
  });
  test("wiring: the change is admitted and cutoverApplied seeded unconditionally, before the walk", () => {
    const capture = at('judgeCapture.noteRouteEnabled({ goal: String(goal ?? ""), enabled: false });');
    const handoff = at("const changeHandoff = routingHandoff({ goal_for_routing: goalForRouting, route_enabled: true });");
    const admit = at(ADMIT_IF);
    expect(capture).toBeGreaterThan(0);
    expect(handoff).toBeGreaterThan(capture);
    expect(admit).toBeGreaterThan(handoff);
    // The admission sits directly in the dispatch's try block: no enclosing switch condition.
    expect(braceDepth(capture, admit)).toBe(0);
    const body = INDEX.slice(admit, at("// WRITE DOOR (target):", admit));
    expect(body).toContain("_changeAdmitted = true;");
    expect(body).toContain("seededOutputShapes = withLandingTarget(seededOutputShapes, isFsWriteShape);");
    expect(body).toContain("noteDispatchedTargets(goal, seededOutputShapes);");
    expect(body).not.toContain("mask");
    const walk = at("let walk = await runGoalAsPoolWalk(goal, {");
    expect(walk).toBeGreaterThan(admit);
  });
  test("wiring: a landed walk counts as an edit (its landing shapes are edit results), so it is not recovered again", () => {
    const shapes = at("const EDIT_RESULT_SHAPES = [");
    expect(shapes).toBeGreaterThan(0);
    const line = INDEX.slice(shapes, INDEX.indexOf("\n", shapes));
    expect(line).toContain('"cutoverapplied"');
    expect(line).toContain('"vesselmitosiscutoverresult"');
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
