// AN ADMISSION REFUSAL IS FINAL: IT IS NEVER ESCALATED TO patch_with_tools (check-first, slice G revision R1+R2).
//
// R1 (qa, 2026-10-08). After a non-FAVORABLE compose the post-walk edit-intent route escalates to patch_with_tools
// unless the spec names a region, there is no verdict, or the failure is an anchor failure (index.ts ~L14540-14612).
// A REFUSED verdict from feature_compose's ADMISSION (the gap is not compose work, is held, or its check-supply ledger
// cannot be verified) has a verdict and no anchor failure, so it escalated. patch-with-tools.ts has no admission of
// its own (no eligibility, hold or check_supply read), mints a pwt-* gap and lands through a mitosis tick: every
// slice-G refusal (a forged marker, ledger_unreadable, gap_missing, the plain unarmed control) became an ungated
// landing. The stop reads the STRUCTURED stage of the compose report, never its error text.
//
// The admission stages (development-vessel resolveFeatureCompose, before any slot, envelope or draft):
//   input, hold_state_unreadable (BUSY), operator_hold (BUSY), ineligible, check_supply_ledger_unreadable,
//   check_supply_gap_missing. NOT admission (unchanged here): budget, gap_in_flight, guard, capacity,
//   landing_lease_* (capacity: BUSY, handled by the existing BUSY stop), scope (the plan/spec scope gates).
//
// R2. With variables.check_supply === true the dispatch id carried to feature_compose (the marker's dispatch_id and
// authoring_execution_id) is the one goal-host minted, never a caller-supplied variables.dispatch_id: a caller that
// pre-set the ledger's id could otherwise replay a dispatch the supply already made. /resolve mints no dispatch id,
// so a check_supply marker arriving there is dropped (the supply dispatches through /run-goal).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const refusal = await import("../src/compose-admission-refusal").catch(() => null) as null | {
  ADMISSION_REFUSAL_STAGES: readonly string[];
  composeAdmissionRefusal: (body: Record<string, unknown> | null | undefined) => string | null;
};
const gid = await import("../src/compose-gap-id") as Record<string, unknown>;
const bind = gid["bindCheckSupplyDispatchId"] as undefined | ((variables: Record<string, unknown>, minted: string | null) => void);
const checkSupplyRouteOf = gid["checkSupplyRouteOf"] as (v: Record<string, unknown> | undefined) => { gap_id: string; dispatch_id: string } | null;
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

const ADMISSION = [
  { verdict: "REFUSED", stage: "ineligible", error: "gap g is not compose work: unarmed (undirected compose not started)" },
  { verdict: "REFUSED", stage: "check_supply_ledger_unreadable", error: "gap g: its check_supply ledger could not be read" },
  { verdict: "REFUSED", stage: "check_supply_gap_missing", error: "gap g: a check_supply compose names a gap the store does not hold" },
  { verdict: "REFUSED", stage: "input", error: "verify_vessels[0] is not a plain vessel name" },
  { verdict: "BUSY", stage: "operator_hold", error: "gap g is under operator_hold" },
  { verdict: "BUSY", stage: "hold_state_unreadable", error: "gap g: the gap store could not be read" },
];

describe("an admission refusal from feature_compose is final", () => {
  for (const body of ADMISSION) {
    test(`[MUST-FAIL] stage ${body.stage} is an admission refusal (no patch_with_tools call)`, () => {
      expect(refusal).not.toBeNull();
      expect(refusal!.composeAdmissionRefusal(body)).toBe(body.stage);
      expect(refusal!.ADMISSION_REFUSAL_STAGES).toContain(body.stage);
    });
  }

  test("[MUST-FAIL] wiring (post-walk route): the stop sits after the BUSY stop and before the escalation, and its return names no patch_with_tools", () => {
    const busyStop = INDEX.indexOf("executionId: `feature_compose:busy:${goalHashOf(goal as string)}`,");
    const stop = INDEX.indexOf("const _admissionStage = composeAdmissionRefusal(body);");
    const escalate = INDEX.indexOf("const pwtResp = await fetch(composeUrl, {");
    expect(busyStop).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(busyStop);
    expect(stop).toBeLessThan(escalate);
    const block = INDEX.slice(stop, INDEX.indexOf("const cutovers = Array.isArray(body.cutovers)", stop));
    expect(block).toContain("return {");
    expect(block).not.toMatch(/fetch\(|type: "patch_with_tools"/);
  });

  test("[MUST-FAIL] wiring (early route): an admission refusal returns instead of falling through to the walk (which composes again and escalates)", () => {
    const stop = INDEX.indexOf("const _earlyAdmissionStage = composeAdmissionRefusal(earlyBody);");
    const fallThrough = INDEX.indexOf("EARLY EDIT-INTENT feature_compose verdict=${earlyVerdict || \"(none)\"} — falling through to walk");
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(fallThrough);
    expect(INDEX.slice(stop, fallThrough)).toContain("return {");
  });

  test("[CONTROL] an apply/anchor failure still escalates: apply_failed, old_string not found, a verify failure, no stage", () => {
    if (!refusal) return;
    for (const body of [
      { verdict: "UNFAVORABLE", apply_failed: true, applied: [{ ok: false, detail: "old_string not found" }] },
      { verdict: "UNFAVORABLE", stage: "apply", applied: [{ ok: false, detail: "no_unique_anchor" }] },
      { verdict: "UNFAVORABLE", verify: [{ ok: false, output: "error TS2304" }] },
      { verdict: "REFUSED", stage: "scope", error: "plan is off-target" },
      { verdict: "FAVORABLE" },
      {},
    ]) expect(refusal.composeAdmissionRefusal(body as Record<string, unknown>)).toBeNull();
    expect(refusal.composeAdmissionRefusal(null)).toBeNull();
  });

  test("[CONTROL] the stop reads the structured stage, never the error text", () => {
    if (!refusal) return;
    expect(refusal.composeAdmissionRefusal({ verdict: "REFUSED", error: "gap g is not compose work: unarmed; stage: ineligible" })).toBeNull();
    expect(refusal.composeAdmissionRefusal({ verdict: "UNFAVORABLE", stage: "semantic", error: "check_supply_gap_missing operator_hold" })).toBeNull();
  });
});

describe("R2: a check_supply dispatch carries the dispatch id goal-host minted", () => {
  test("[MUST-FAIL] a caller-supplied dispatch_id equal to the ledger's does not reach the pointer marker (/run-goal)", () => {
    expect(typeof bind).toBe("function");
    const v: Record<string, unknown> = { gap_id: "g", check_supply: true, dispatch_id: "the-ledger-dispatch-id" };
    bind!(v, "minted-dispatch-1");
    expect(checkSupplyRouteOf(v)).toEqual({ gap_id: "g", dispatch_id: "minted-dispatch-1" });
    expect(v["dispatch_id"]).toBe("minted-dispatch-1");
  });

  test("[MUST-FAIL] with no minted id (/resolve) a check_supply marker is dropped, so a caller id cannot ride through", () => {
    expect(typeof bind).toBe("function");
    const v: Record<string, unknown> = { gap_id: "g", check_supply: true, dispatch_id: "the-ledger-dispatch-id" };
    bind!(v, null);
    expect(checkSupplyRouteOf(v)).toBeNull();
  });

  test("[MUST-FAIL] wiring: /run-goal binds with its minted dispatchId, /resolve with null, before the walk", () => {
    expect(INDEX).toContain("bindCheckSupplyDispatchId(variables, dispatchId);");
    expect(INDEX).not.toContain('if (!("dispatch_id" in variables)) variables.dispatch_id = dispatchId;');
    const resolveBind = INDEX.indexOf("bindCheckSupplyDispatchId(variables, null);");
    const resolveSeek = INDEX.indexOf("const __seekP = runGoalWithRecovery(goal, {");
    expect(resolveBind).toBeGreaterThan(0);
    expect(resolveBind).toBeLessThan(resolveSeek);
  });

  test("[CONTROL] without check_supply a caller dispatch_id is kept and an absent one is minted, exactly as before", () => {
    if (!bind) return;
    const kept: Record<string, unknown> = { dispatch_id: "caller-parent-id" };
    bind(kept, "minted-2");
    expect(kept["dispatch_id"]).toBe("caller-parent-id");
    const absent: Record<string, unknown> = {};
    bind(absent, "minted-3");
    expect(absent["dispatch_id"]).toBe("minted-3");
    const resolveCase: Record<string, unknown> = { dispatch_id: "x" };
    bind(resolveCase, null);
    expect(resolveCase).toEqual({ dispatch_id: "x" });
  });
});
