// Wiring for check-supply-ledger-reason.test.ts: both check-supply ledger lines in index.ts's early edit-intent route
// carry the compose's stage. Source-level (the route runs inside runGoalWithRecoveryInner, which needs the vessel
// booted), so on the old form each assertion fails for that reason.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
const at = (s: string): number => INDEX.indexOf(s);

describe("[MUST-FAIL] the cut-caller ledger line appends the outcome the compose recorded", () => {
  test("the no-walk stop reads the gap row and builds its line with cutCallerReason (the outcome before the gap id)", () => {
    const stop = at("if (_earlyCheckSupplyNoWalk) {");
    const block = INDEX.slice(stop, stop + 2000);
    expect(block).toContain("cutCallerOutcome(await readGapByIdForOracle(_probeGapId)");
    expect(block).toContain("goalReachReason: cutCallerReason(_probeGapId, _cutOutcome),");
  });
  test("the cut is timed where it is detected", () => {
    expect(INDEX).toContain("_earlyComposeCutAtCaller = true; _earlyComposeCutAtS = Math.round((Date.now() - _dispatchStartMs) / 1000);");
  });
});

describe("[MUST-FAIL] the OK-path refusal line derives its stage", () => {
  test("_stage comes from composeReportStage, so the line keeps 'refused at ${_stage}' with a derived stage", () => {
    expect(INDEX).toContain("const _stage = composeReportStage(earlyBody);");
    expect(INDEX).not.toContain('const _stage = String(earlyBody.stage ?? "(none)");');
    expect(INDEX).toContain("check_supply compose refused at ${_stage} (verdict=");
  });
});

describe("CONTROL: a landed goal is unchanged", () => {
  test("the landed-probe return comes before the gap read, with its reason as before", () => {
    const landed = at("EARLY EDIT-INTENT LANDED-PROBE found ${_probeSha} for ${_probeGapId} since dispatch start - ending the dispatch");
    const read = at("cutCallerOutcome(await readGapByIdForOracle(_probeGapId)");
    expect(landed).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(landed);
    expect(INDEX).toContain("goalReachReason: `deterministic:early-edit-intent-${_probeReached ? \"landed\" : \"hollow\"} — the compose reply was lost or non-favourable, but git shows ${_probeSha} for ${_probeGapId} on origin/dev since this dispatch started");
  });
});
