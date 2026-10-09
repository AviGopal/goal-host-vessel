// A CHECK-SUPPLY GOAL NEVER LEAVES THE feature_compose ROUTE WHEN THE COMPOSE CALL FAILS (check-first, L1b follow-up).
//
// L1b stopped a marked compose that RETURNED a non-FAVORABLE body (check-supply-no-escalation.test.ts). When the
// compose call THROWS or answers HTTP non-OK, a marked goal still had three routes off the compose path:
//   - early route, throw or non-OK (other than 503/429): the landed probe found nothing and control fell through to the
//     pool walk, whose template candidates and shellResult satisfier are not provably write-free (only the fs-write
//     SHAPES are refused, fs-write-shapes.ts), and then on to the post-walk route and the recovery loop;
//   - post-walk route, the compose call throws: the catch falls through to authorFallback/recommend;
//   - any throw in the walk block (the pool-walk catch), or a pinned target: the single-template recovery loop, which
//     runs host.runGoal on a recommended template for the goal's shapes (fileEditResult producers are write-capable).
// Each now returns for a marked goal, with a named log. The marker test is hardened at every stop, the two L1b stops
// included: checkSupplyRouteOf(opts.variables) !== null || opts.variables?.check_supply === true, so a malformed
// marker (check_supply:true with no dispatch_id or a bad gap_id) stops too. It only ever stops more.
//
// Seam: as in check-supply-no-escalation.test.ts, the routes cannot be driven at runtime (index.ts boots the vessel on
// import). These tests pin each stop's placement and EVALUATE its condition, extracted verbatim from index.ts.
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
  { stopVar: "_earlyCheckSupplyNoWalk", where: "early route, compose threw or answered non-OK: no walk" },
  { stopVar: "_checkSupplyComposeThrew", where: "post-walk route, compose threw: no authorFallback/recommend" },
  { stopVar: "_checkSupplyNoAuthorFallback", where: "before authorFallback" },
  { stopVar: "_checkSupplyNoRecoveryLoop", where: "before the single-template recovery loop" },
];
const L1B_STOPS = [
  { stopVar: "_earlyCheckSupplyStop", where: "L1b early stop" },
  { stopVar: "_checkSupplyStop", where: "L1b post-walk stop" },
];

describe("a check_supply-marked goal never leaves the compose route when the compose call fails", () => {
  for (const { stopVar, where } of NEW_STOPS) {
    test(`[MUST-FAIL] ${where}: a marked goal stops`, () => {
      const stop = stopOf(stopVar);
      expect(stop).not.toBeNull();
      expect(stop!(MARKED)).toBe(true);
    });
  }

  test("[MUST-FAIL] wiring (early route): after the landed probe, before the fall-through to the walk, and returns", () => {
    const probeHit = at("EARLY EDIT-INTENT LANDED-PROBE found ${_probeSha} for ${_probeGapId}");
    const stop = at("const _earlyCheckSupplyNoWalk = ");
    const fallThrough = at("EARLY EDIT-INTENT LANDED-PROBE found no commit for ${_probeGapId} since dispatch start — falling through to walk");
    expect(probeHit).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(probeHit);
    expect(stop).toBeLessThan(fallThrough);
    const block = INDEX.slice(stop, fallThrough);
    expect(block).toContain("if (_earlyCheckSupplyNoWalk) {");
    expect(block).toContain(": no escalation");
    expect(block).toContain("return {");
    expect(block).toContain("reached: false");
    expect(block).not.toMatch(/fetch\(|runGoalAsPoolWalk|host\.runGoal/);
  });

  test("[MUST-FAIL] wiring (post-walk route): the compose catch returns before ACTIVITY-REPAIR and authorFallback", () => {
    const threw = at("EDIT-INTENT feature_compose call failed (${(e as Error).message}) — falling through to authorFallback/recommend");
    const stop = at("const _checkSupplyComposeThrew = ");
    const repair = at("// ACTIVITY-REPAIR interception");
    expect(threw).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(threw);
    expect(stop).toBeLessThan(repair);
    const block = INDEX.slice(stop, repair);
    expect(block).toContain("if (_checkSupplyComposeThrew) {");
    expect(block).toContain(": no escalation");
    expect(block).toContain("return {");
    expect(block).not.toMatch(/fetch\(|authorFallback\(|host\.runGoal/);
  });

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

  for (const { stopVar, where } of [...NEW_STOPS, ...L1B_STOPS]) {
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
  for (const { stopVar, where } of [...NEW_STOPS, ...L1B_STOPS]) {
    test(`[CONTROL] ${where}: an UNMARKED goal does not stop`, () => {
      const stop = stopOf(stopVar);
      if (!stop) return;   // vacuous until the stop exists
      for (const v of UNMARKED) expect(stop(v)).toBe(false);
    });
  }

  test("[CONTROL] the unmarked routes are still there: the walk, the post-walk patch_with_tools escalation, authorFallback and the recovery loop", () => {
    expect(at("let walk = await runGoalAsPoolWalk(goal, {")).toBeGreaterThan(0);
    const escalate = at("const pwtResp = await fetch(composeUrl, {");
    expect(escalate).toBeGreaterThan(0);
    expect(INDEX.slice(escalate, escalate + 600)).toContain('type: "patch_with_tools"');
    expect(at("try { authoredFallbackTarget = await opts.authorFallback(); }")).toBeGreaterThan(0);
    expect(at("result = await host.runGoal(goal ?? `execute template ${nextTarget}`, {")).toBeGreaterThan(0);
  });
});
