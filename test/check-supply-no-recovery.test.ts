// A CHECK-SUPPLY GOAL NEVER REACHES authorFallback OR THE SINGLE-TEMPLATE RECOVERY LOOP (check-first, L1b follow-up).
//
// Any throw in the walk block (the pool-walk catch), a 0-step walk or a pinned target would otherwise run the
// single-template recovery loop, which runs host.runGoal on a recommended template for the goal's shapes
// (fileEditResult producers are write-capable). Each stop returns for a marked goal, with a named log. The marker test
// is hardened at every stop: checkSupplyRouteOf(opts.variables) !== null || opts.variables?.check_supply === true, so a
// malformed marker (check_supply:true with no dispatch_id or a bad gap_id) stops too. It only ever stops more.
//
// Seam: the routes cannot be driven at runtime (index.ts boots the vessel on import). These tests pin each stop's
// placement and EVALUATE its condition, extracted verbatim from index.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSupplyRouteOf } from "../src/compose-gap-id";

const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

const MARKED: Record<string, unknown> = { gap_id: "gap-x", check_supply: true, dispatch_id: "dispatch-1" };
const MALFORMED: Array<{ name: string; variables: Record<string, unknown> }> = [
  { name: "check_supply:true with no dispatch_id", variables: { gap_id: "gap-x", check_supply: true } },
  { name: "check_supply:true with an invalid gap_id", variables: { gap_id: "bad gap id with spaces", check_supply: true, dispatch_id: "d" } },
];
const UNMARKED: Array<Record<string, unknown>> = [{}, { gap_id: "gap-x", dispatch_id: "dispatch-1" }, { gap_id: "gap-x", check_supply: false, dispatch_id: "d" }];
const ANCHOR_FAILURE: Record<string, unknown> = { ok: false, verdict: "UNFAVORABLE", apply_failed: true, applied: [{ ok: false, detail: "old_string not found" }] };

/** The stop's condition, extracted verbatim from index.ts and evaluated over a request's variables. */
function stopOf(name: string): ((variables: Record<string, unknown>) => boolean) | null {
  const m = new RegExp(`const ${name} = (.+);\\n`).exec(INDEX);
  if (!m) return null;
  const fn = new Function("checkSupplyRouteOf", "opts", "body", "earlyBody", "verdict", "earlyVerdict", `return Boolean(${m[1]});`);
  return (variables) => fn(checkSupplyRouteOf, { variables }, ANCHOR_FAILURE, ANCHOR_FAILURE, "UNFAVORABLE", "UNFAVORABLE") as boolean;
}

const at = (s: string, from = 0): number => INDEX.indexOf(s, from);

const NEW_STOPS = [
  { stopVar: "_checkSupplyNoAuthorFallback", where: "before authorFallback" },
  { stopVar: "_checkSupplyNoRecoveryLoop", where: "before the single-template recovery loop" },
];
describe("a check_supply-marked goal never reaches authorFallback or the recovery loop", () => {
  for (const { stopVar, where } of NEW_STOPS) {
    test(`[MUST-FAIL] ${where}: a marked goal stops`, () => {
      const stop = stopOf(stopVar);
      expect(stop).not.toBeNull();
      expect(stop!(MARKED)).toBe(true);
    });
  }

  test("[MUST-FAIL] wiring: authorFallback is not called for a marked goal", () => {
    const zeroStep = at("pool-walk took 0 shape-feasible steps — falling back to single-template recovery loop");
    const stop = at("const _checkSupplyNoAuthorFallback = ");
    const author = at("if (opts.authorFallback) {");
    expect(zeroStep).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(zeroStep);
    expect(stop).toBeLessThan(author);
    const block = INDEX.slice(stop, author);
    expect(block).toContain("if (_checkSupplyNoAuthorFallback) {");
    expect(block).toContain("return {");
  });

  test("[MUST-FAIL] wiring: the recovery loop is not entered for a marked goal (pool-walk error, pinned target)", () => {
    const walkErr = at("pool-walk error (${(e as Error).message}) — falling back to single-template recovery loop");
    const stop = at("const _checkSupplyNoRecoveryLoop = ");
    const maxAttempts = at("const maxAttempts = opts.callerPinned || !goal ? 1 : opts.maxAttempts;");
    const runLoop = at("result = await host.runGoal(goal ?? `execute template ${nextTarget}`, {");
    expect(walkErr).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(walkErr);
    expect(stop).toBeLessThan(maxAttempts);
    expect(maxAttempts).toBeLessThan(runLoop);
    const block = INDEX.slice(stop, maxAttempts);
    expect(block).toContain("if (_checkSupplyNoRecoveryLoop) {");
    expect(block).toContain("return {");
  });

  for (const { stopVar, where } of NEW_STOPS) {
    for (const { name, variables } of MALFORMED) {
      test(`[MUST-FAIL] ${where}: a MALFORMED marker (${name}) stops`, () => {
        const stop = stopOf(stopVar);
        expect(stop).not.toBeNull();
        expect(checkSupplyRouteOf(variables)).toBeNull();   // the parser rejects it, so only the hardening catches it
        expect(stop!(variables)).toBe(true);
      });
    }
  }
});

describe("controls: an unmarked goal keeps every existing route", () => {
  for (const { stopVar, where } of NEW_STOPS) {
    test(`[CONTROL] ${where}: an UNMARKED goal does not stop`, () => {
      const stop = stopOf(stopVar);
      if (!stop) return;   // vacuous until the stop exists
      for (const v of UNMARKED) expect(stop(v)).toBe(false);
    });
  }

  test("[CONTROL] the unmarked routes are still there: the walk, authorFallback and the recovery loop", () => {
    expect(at("let walk = await runGoalAsPoolWalk(goal, {")).toBeGreaterThan(0);
    expect(at("try { authoredFallbackTarget = await opts.authorFallback(); }")).toBeGreaterThan(0);
    expect(at("result = await host.runGoal(goal ?? `execute template ${nextTarget}`, {")).toBeGreaterThan(0);
  });
});
