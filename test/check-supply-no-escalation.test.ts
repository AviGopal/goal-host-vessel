// A CHECK-SUPPLY COMPOSE IS NEVER ESCALATED, WHATEVER STAGE REFUSED IT (check-first, harm containment L1b).
//
// Measured 2026-10-08 (dispatch d61d8b41): a B′ test-writing compose carrying the check supply's marker was refused by
// development-vessel's test-writing floor (stage test_writing_diff_outside_tests). That stage is not an admission
// stage (compose-admission-refusal.ts), so the post-walk edit-intent route escalated it to patch_with_tools, which has
// no test-writing scope rule: it wrote a file straight into the live development-vessel test/checks/ and only an LLM
// semantic gate stopped it. Extending ADMISSION_REFUSAL_STAGES would not fix the class (qa): every future test-writing
// floor would need a list entry, and that file is lane-editable.
//
// Rule (qa): when the request carried a check_supply marker (checkSupplyRouteOf(opts.variables) is non-null), a
// non-FAVORABLE compose is final at BOTH edit-intent routes, the same two R1 stops at
// (admission-refusal-no-escalation.test.ts): the early route returns instead of falling through to the walk (which
// composes again and escalates), and the post-walk route returns before the patch_with_tools fetch. The decision lives
// in index.ts (autonomy-scope excluded), keyed on the marker, never on the stage or the error text.
//
// Test seam: the routes run inside runGoalWithRecoveryInner, which cannot be driven at runtime without booting the
// vessel (index.ts starts its server on import). As R1 does, these tests pin the wiring in the source, and in addition
// they EVALUATE each stop's condition expression, extracted verbatim from index.ts, against the refusal bodies, so a
// stop keyed on a stage rather than on the marker fails here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSupplyRouteOf } from "../src/compose-gap-id";

const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

const MARKED: Record<string, unknown> = { gap_id: "gap-x", check_supply: true, dispatch_id: "dispatch-1" };

// development-vessel feature_compose refusals of a check-supply (test_writing) compose. No body carries an error text
// the stop could depend on: the defect's compose report had "no failure detail".
const REFUSALS: Array<{ name: string; body: Record<string, unknown> }> = [
  { name: "test-writing floor test_writing_diff_outside_tests", body: { ok: false, verdict: "REFUSED", stage: "test_writing_diff_outside_tests" } },
  { name: "W1 test_writing_check_flaky", body: { ok: false, verdict: "REFUSED", stage: "test_writing_check_flaky" } },
  { name: "W1 test_writing_check_wrong_reason", body: { ok: false, verdict: "REFUSED", stage: "test_writing_check_wrong_reason" } },
  { name: "W2 test_writing_check_misses_edit_site", body: { ok: false, verdict: "REFUSED", stage: "test_writing_check_misses_edit_site" } },
  { name: "a generic verify failure", body: { ok: false, verdict: "UNFAVORABLE", verify: [{ ok: false, vessel: "repos/development-vessel", output: "error TS2304: Cannot find name 'x'" }] } },
];

const ANCHOR_FAILURE: Record<string, unknown> = { ok: false, verdict: "UNFAVORABLE", apply_failed: true, applied: [{ ok: false, detail: "old_string not found" }] };

type Stop = (variables: Record<string, unknown>, body: Record<string, unknown>) => boolean;

/** The stop's condition, extracted verbatim from index.ts and evaluated over a request's variables and a compose body. */
function stopOf(name: string): Stop | null {
  const m = new RegExp(`const ${name} = (.+);\\n`).exec(INDEX);
  if (!m) return null;
  const fn = new Function("checkSupplyRouteOf", "opts", "body", "earlyBody", "verdict", "earlyVerdict", `return Boolean(${m[1]});`);
  return (variables, body) => {
    const v = String(body["verdict"] ?? "");
    return fn(checkSupplyRouteOf, { variables }, body, body, v, v) as boolean;
  };
}

const ROUTES = [
  { route: "early", stopVar: "_earlyCheckSupplyStop" },
  { route: "post-walk", stopVar: "_checkSupplyStop" },
];

describe("a check_supply-marked compose refused at any stage is never escalated", () => {
  for (const { route, stopVar } of ROUTES) {
    for (const { name, body } of REFUSALS) {
      test(`[MUST-FAIL] ${route} route: marked + ${name} stops (no patch_with_tools call)`, () => {
        const stop = stopOf(stopVar);
        expect(stop).not.toBeNull();
        expect(stop!(MARKED, body)).toBe(true);
      });
    }
  }

  test("[MUST-FAIL] wiring (early route): the stop sits after the R1 admission stop, before the fall-through to the walk, and returns", () => {
    const r1 = INDEX.indexOf("const _earlyAdmissionStage = composeAdmissionRefusal(earlyBody);");
    const stop = INDEX.indexOf("const _earlyCheckSupplyStop = ");
    const fallThrough = INDEX.indexOf("EARLY EDIT-INTENT feature_compose verdict=${earlyVerdict || \"(none)\"} — falling through to walk");
    expect(r1).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(r1);
    expect(stop).toBeLessThan(fallThrough);
    const block = INDEX.slice(stop, fallThrough);
    expect(block).toContain("if (_earlyCheckSupplyStop) {");
    expect(block).toContain("check_supply compose refused at ${");
    expect(block).toContain(": no escalation");
    expect(block).toContain("return {");
    expect(block).toContain("reached: false");
    expect(block).not.toMatch(/fetch\(|type: "patch_with_tools"/);
  });

  test("[MUST-FAIL] wiring (post-walk route): the stop sits after the FAVORABLE return, before the escalation fetch, and returns", () => {
    const favorable = INDEX.indexOf("goalReachReason: `deterministic:edit-intent-${landedSha ? \"landed\" : \"staged-not-landed\"}");
    const stop = INDEX.indexOf("const _checkSupplyStop = ");
    const escalate = INDEX.indexOf("const pwtResp = await fetch(composeUrl, {");
    expect(favorable).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(favorable);
    expect(stop).toBeLessThan(escalate);
    const block = INDEX.slice(stop, INDEX.indexOf("// STRATEGY ESCALATION", stop));
    expect(block).toContain("if (_checkSupplyStop) {");
    expect(block).toContain("check_supply compose refused at ${");
    expect(block).toContain(": no escalation");
    expect(block).toContain("return {");
    expect(block).toContain("reached: false");
    expect(block).not.toMatch(/fetch\(|type: "patch_with_tools"/);
  });
});

describe("controls: an unmarked compose escalates exactly as before", () => {
  for (const { route, stopVar } of ROUTES) {
    test(`[CONTROL] ${route} route: an UNMARKED compose with an anchor failure does not stop`, () => {
      const stop = stopOf(stopVar);
      if (!stop) return;   // vacuous until the stop exists
      expect(stop({}, ANCHOR_FAILURE)).toBe(false);
      expect(stop({ gap_id: "gap-x", dispatch_id: "dispatch-1" }, ANCHOR_FAILURE)).toBe(false);
      for (const { body } of REFUSALS) expect(stop({}, body)).toBe(false);
    });
  }

  test("[CONTROL] early route: an unmarked non-FAVORABLE compose still falls through to the walk (the early route makes no patch_with_tools call itself)", () => {
    const fallThrough = INDEX.indexOf("EARLY EDIT-INTENT feature_compose verdict=${earlyVerdict || \"(none)\"} — falling through to walk");
    expect(fallThrough).toBeGreaterThan(0);
    const stop = INDEX.indexOf("const _earlyCheckSupplyStop = ");
    if (stop > 0) expect(fallThrough).toBeGreaterThan(stop);
  });

  test("[CONTROL] post-walk route: the patch_with_tools escalation is still reached for an unmarked compose", () => {
    const escalate = INDEX.indexOf("const pwtResp = await fetch(composeUrl, {");
    expect(escalate).toBeGreaterThan(0);
    expect(INDEX.slice(escalate, escalate + 600)).toContain('type: "patch_with_tools"');
    const stop = INDEX.indexOf("const _checkSupplyStop = ");
    if (stop > 0) expect(escalate).toBeGreaterThan(stop);
  });
});
