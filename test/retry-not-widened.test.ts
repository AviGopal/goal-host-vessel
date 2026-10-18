// A RETRY DOES NOT WIDEN PAST A GRADER THAT ACCEPTS ONLY ONE SHAPE.
//
// The hollow-satisfier retry (runGoalWithRecoveryInner) widens a retry's targets to ["shellResult", "httpResponse",
// "webSearchResult"] when the suppressed satisfier's shape was the whole target. For a gap investigation the whole target
// is gapDecomposition and its grader (the CHANGE-35 gap-investigation oracle in the reach gate) accepts ONLY a
// gapDecomposition the gap store confirms, so every widened retry was wasted by construction (one dispatch reached
// attempt_count 13). The fourth condition uses the same field-only predicate that binds that oracle (gapIdForGrading).
//
//   [MUST-FAIL] an investigation bound by its decompose_gap_id field, hollow satisfier on gapDecomposition: no widened
//               retry, no retry walk, a named and counted retry_not_widened reason.
//   [CONTROL]   a non-investigation goal whose whole target is suppressed still widens exactly as before; a goal that
//               merely reads as an investigation (no field) does not bind the predicate.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gapIdForGrading } from "../src/compose-gap-id";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
const start = SRC.indexOf("const suppressedShape = walk.selectedTemplateId.slice(\"satisfier:\".length);");
const end = SRC.indexOf("// ALTERNATIVE-FRAMING retry.", start);
const block = start > 0 && end > start ? SRC.slice(start, end) : "";

describe("the hollow-satisfier retry and a single-shape grader", () => {
  test("[MUST-FAIL] a field-bound gap investigation is not widened and runs no retry walk, with a named counted reason", () => {
    expect(block.length).toBeGreaterThan(0);
    // the same predicate that binds the CHANGE-35 oracle in the reach gate, read from the dispatch's field
    expect(block).toContain('const _graderOnlyShape = gapIdForGrading(goal, dispatchContext.getStore()?.decomposeGapId).gapId !== null ? "gapDecomposition" : null;');
    expect(SRC).toContain("const _gapGrade = gapIdForGrading(goal, dispatchContext.getStore()?.decomposeGapId);");
    // and only when the hollow satisfier is the very shape the grader accepts
    expect(block).toContain("const _retryNotWidened = _suppressedIsWholeTarget && !_suppressedIsWrite && _graderOnlyShape !== null && _suppressedLc === _graderOnlyShape.toLowerCase();");
    expect(block).toContain("retry_not_widened: grader accepts only ${_graderOnlyShape} and its producer failed");
    expect(block).toContain("walk = { ...walk, goalReachReason: `${walk.goalReachReason ?? \"not reached\"}; ${_rnw}` };");
    // the not-widened branch is counted, and the retry (its log, its route record, the widening and the walk) runs only
    // in the else branch, which holds every one of them
    const notWidened = block.indexOf("if (_retryNotWidened) {");
    const orElse = block.indexOf("} else {", notWidened);
    expect(notWidened).toBeGreaterThan(0);
    expect(block.slice(notWidened, orElse)).toContain("_retryNotWidenedCount += 1;");
    expect(block.slice(notWidened, orElse)).not.toContain("runGoalAsPoolWalk(");
    for (const inRetry of ['noteRouteTaken(walk.routeAround, "retry:satisfier-suppressed");', "const _widenRetryTarget = _suppressedIsWholeTarget && !_suppressedIsWrite;", "const retryWalk = await runGoalAsPoolWalk(goal, {", "walk = retryWalk.attempts > 0 ? retryWalk : walk;"]) {
      expect(block.indexOf(inRetry)).toBeGreaterThan(orElse);
    }
    // and the bound case is what the field produces
    expect(gapIdForGrading("Look into gap-x and break it down", "gap-x").gapId).toBe("gap-x");
  });

  test("[CONTROL] a non-investigation goal whose whole target is suppressed still widens as before", () => {
    expect(gapIdForGrading("What is the distance from Earth to Io right now?", undefined)).toEqual({ investigation: false, gapId: null });
    // reading as an investigation without the field does not bind the single-shape grader either
    expect(gapIdForGrading("investigate and decompose gap gap-x: the lane", undefined).gapId).toBeNull();
    // with _graderOnlyShape null the widening condition reduces to the original two
    expect(block).toContain('const _retryOutputShapes = _widenRetryTarget ? ["shellResult", "httpResponse", "webSearchResult"] : seededOutputShapes;');
    expect(block).toContain("const _suppressedIsWrite = /(write|persist|save|edit|commit|apply|insert|update|delete)/.test(_suppressedLc);");
    expect(block).toContain("seededOutputShapes.every((s) => String(s).toLowerCase() === _suppressedLc);");
  });
});
