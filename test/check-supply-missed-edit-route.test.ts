// A CHECK-SUPPLY GOAL THAT MISSED THE EARLY EDIT-INTENT ROUTE IS REFUSED BEFORE THE WALK, VISIBLY (check-first, L1b X).
//
// The early edit-intent route fires only on a goal that names a repos file AND carries an edit verb (or names exactly
// one file and no read verb). The supply's goal text enters it today by accident: "Do not change src/" matches `change`.
// A marked goal that does not enter it went to the pool walk, whose template candidates and shellResult satisfier are
// not provably write-free (only the fs-write SHAPES are refused, fs-write-shapes.ts). Every marked goal that DID enter
// the early route returns inside it (the L1b stops), so a marked goal reaching the walk has missed the route.
//
// Rule (qa option X): such a goal is refused before the reuse lookup, the floor shortcut and runGoalAsPoolWalk (and its
// fb/retry/alt variants), with the named reason check_supply_goal_missed_edit_route, carried as the result's `stage`
// and in its goalReachReason, mapped onto the dispatch record and served by GET /executions/:id so a supply ledger or a
// diagnosis can count the misses. Same marker condition as every other check-supply stop (malformed markers included).
//
// Seam: as in check-supply-no-escalation.test.ts, the route cannot be driven at runtime (index.ts boots the vessel on
// import). These tests pin placement and evaluate the stop's condition, extracted verbatim from index.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSupplyRouteOf } from "../src/compose-gap-id";

const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
const STAGE = "check_supply_goal_missed_edit_route";

const MARKED: Array<Record<string, unknown>> = [
  { gap_id: "gap-x", check_supply: true, dispatch_id: "dispatch-1" },
  { gap_id: "gap-x", check_supply: true },                                  // malformed: no dispatch_id
];
const UNMARKED: Array<Record<string, unknown>> = [{}, { gap_id: "gap-x", dispatch_id: "dispatch-1" }, { gap_id: "gap-x", check_supply: false, dispatch_id: "d" }];

// Goal texts that do not enter the early route: no repos file, and a repos file with no edit verb and a read verb.
const MISSED_TEXTS = [
  "Write ONE failing test that reproduces the defect in the gap store's retention sweep.",
  "Write ONE failing test in repos/development-vessel/test/checks/gap-x.check.ts that shows the count of open gaps.",
];

function stopOf(name: string): ((variables: Record<string, unknown>, goal: string) => boolean) | null {
  const m = new RegExp(`const ${name} = (.+);\\n`).exec(INDEX);
  if (!m) return null;
  const fn = new Function("checkSupplyRouteOf", "opts", "goal", `return Boolean(${m[1]});`);
  return (variables, goal) => fn(checkSupplyRouteOf, { variables }, goal) as boolean;
}

const at = (s: string, from = 0): number => INDEX.indexOf(s, from);
const EARLY_IF = "if (earlyEditIntentEnabled && earlyFileMatch && (earlyEditVerb || earlyFileOnlyMatch)) {";
const STOP_DECL = "const _checkSupplyMissedEditRoute = ";

/** Brace depth of `to` relative to `from`, skipping string and template-literal text (template ${} counted). */
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

describe("a check_supply goal that missed the early edit-intent route is refused before the walk", () => {
  for (const variables of MARKED) {
    for (const goal of MISSED_TEXTS) {
      test(`[MUST-FAIL] marked ${JSON.stringify(variables)}, goal "${goal.slice(0, 50)}…" stops`, () => {
        const stop = stopOf("_checkSupplyMissedEditRoute");
        expect(stop).not.toBeNull();
        expect(stop!(variables, goal)).toBe(true);
      });
    }
  }

  test("[MUST-FAIL] wiring: the stop sits AFTER the early route's block (not inside it) and BEFORE the reuse lookup, the floor and every walk", () => {
    const earlyIf = at(EARLY_IF);
    const stop = at(STOP_DECL);
    expect(earlyIf).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(earlyIf);
    expect(braceDepth(earlyIf, stop)).toBe(0);   // the early route's `if` block has closed: a goal that missed it gets here
    const reuse = at("reachingPathway = await recommendReachingPath(goal, seededOutputShapes ?? null);", earlyIf);
    const floor = at("const reused = await universalToolFallback(", earlyIf);
    const walk = at("let walk = await runGoalAsPoolWalk(goal, {");
    for (const later of [reuse, floor, walk, at("const fbWalk = await runGoalAsPoolWalk(goal, {"), at("const retryWalk = await runGoalAsPoolWalk(goal, {"), at("const altWalkResult = await runGoalAsPoolWalk(goal, {")]) {
      expect(later).toBeGreaterThan(stop);
    }
    const block = INDEX.slice(stop, reuse);
    expect(block).toContain("if (_checkSupplyMissedEditRoute) {");
    expect(block).toContain("return {");
    expect(block).toContain(`stage: "${STAGE}"`);
    expect(block).toContain("reached: false");
    expect(block).toMatch(new RegExp(`goalReachReason: \`${STAGE}[:\\s]`));
    expect(block).not.toMatch(/runGoalAsPoolWalk|universalToolFallback|host\.runGoal|fetch\(/);
  });

  test("[MUST-FAIL] visibility: the result's stage reaches the dispatch record and GET /executions/:id", () => {
    const seekIface = INDEX.slice(at("interface GoalSeekResult {"), at("interface GoalSeekResult {") + 4000);
    expect(seekIface).toMatch(/\n\s+stage\?: string;/);
    const recIface = INDEX.slice(at("interface DispatchRecord {"), at("interface DispatchRecord {") + 6000);
    expect(recIface).toMatch(/\n\s+stage\?: string;/);
    const reasonMap = at("if (seek.goalReachReason) record.goalReachReason = seek.goalReachReason;");
    expect(reasonMap).toBeGreaterThan(0);
    expect(INDEX.slice(reasonMap, reasonMap + 300)).toContain("if (seek.stage) record.stage = seek.stage;");
    const get = at('if (req.method === "GET" && url.pathname.startsWith("/executions/")) {');
    const getBody = INDEX.slice(get, at("if (req.method === \"POST\" && url.pathname === \"/resolve\")", get));
    expect(getBody).toContain("stage: record.stage ?? null,");
  });
});

describe("controls: an unmarked goal with the same text still walks", () => {
  test("[CONTROL] an UNMARKED goal does not stop", () => {
    const stop = stopOf("_checkSupplyMissedEditRoute");
    if (!stop) return;   // vacuous until the stop exists
    for (const v of UNMARKED) for (const g of MISSED_TEXTS) expect(stop(v, g)).toBe(false);
  });

  test("[CONTROL] the walk is still reached after the early route for an unmarked goal", () => {
    const earlyIf = at(EARLY_IF);
    const walk = at("let walk = await runGoalAsPoolWalk(goal, {");
    expect(earlyIf).toBeGreaterThan(0);
    expect(walk).toBeGreaterThan(earlyIf);
    const stop = at(STOP_DECL);
    if (stop > 0) expect(walk).toBeGreaterThan(stop);
  });
});
