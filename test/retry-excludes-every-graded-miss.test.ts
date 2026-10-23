// A RETRY AVOIDS THE TARGETS OF EVERY GRADED MISS, NOT ONLY OF A NO-ARTIFACT ONE (REALIGNMENT R:181; wiring item W3).
// targetsToAvoid continued its run only over `deterministic:write-goal-no-artifact` records: two hollow runs graded by
// any other verdict class (report-incomplete, wrong-compute-answer, ...) on target X left the third attempt free to
// choose X again. The run now continues over every graded verdict (GRADED_VERDICT_REASON, the anchored rule the
// failure memory already uses); a record that is not a verdict still ends it, and a reach still clears the memory.
//
//   [MUST-FAIL] two graded misses on X (bare and floor-wrapped) -> the third attempt avoids X.
//   [MUST-FAIL] a graded miss on X then a no-artifact miss on Y -> both are avoided.
//   [MUST-FAIL] deterministic:judge-rules-refused is a graded verdict too: its targets are avoided (pinned positively).
//   [CONTROL]   a newer record that is not a verdict ends the run; an unanchored mention is not a verdict; nothing to
//               avoid is [] — and a goal that reached has no records since (recallGoalFailures), so it avoids nothing.
import { describe, expect, it } from "bun:test";
import * as GTI from "../src/goal-target-inference";
import * as FT from "../src/failed-targets";
import { exactFailuresSince } from "../src/capability-demand";

const KNOWN = ["gitCommitResult", "gitStatusResult", "shellResult", "webSearchResult"];
const GOAL = "Show the git status of the super-repo clone";
const llm = { complete: async () => JSON.stringify({ target_shapes: ["gitStatusResult"], alternatives: [["shellResult"]] }) };
const MISS = "deterministic:report-incomplete — the answer does not report the branch";
const NA = "deterministic:write-goal-no-artifact — no artifact on the target";

describe("a retry avoids the targets of every graded miss", () => {
  it("[MUST-FAIL] two graded misses on X: the third attempt avoids X", async () => {
    const records = [
      { at: "2026-10-24T10:00:00Z", reason: MISS, targets: ["gitStatusResult"] },
      { at: "2026-10-24T10:05:00Z", reason: `floor floor:upstream-not-reached: ${MISS}`, targets: ["gitStatusResult"] },
    ];
    const avoid = FT.targetsToAvoid(records);
    expect(avoid).toEqual(["gitStatusResult"]);
    const a3 = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { ...llm, excludeTargets: avoid } as never);
    expect(a3.shapes).not.toContain("gitStatusResult");
  });

  it("[MUST-FAIL] a graded miss then a no-artifact miss: both targets are avoided", () => {
    expect([...FT.targetsToAvoid([
      { at: "2026-10-24T10:00:00Z", reason: "deterministic:wrong-compute-answer — 41, expected 42", targets: ["shellResult"] },
      { at: "2026-10-24T10:05:00Z", reason: NA, targets: ["gitCommitResult"] },
    ])].sort()).toEqual(["gitCommitResult", "shellResult"]);
  });

  it("[MUST-FAIL] a judge-rules-refused verdict is a graded miss: its targets are now avoided too", () => {
    // The example retry-avoids-every-failed-target's control used for "another kind of failure" before R:181: the run
    // used to end at it; it is a graded verdict now, so it continues the run and its targets are excluded.
    expect([...FT.targetsToAvoid([
      { at: "2026-10-16T10:00:00Z", reason: NA, targets: ["gitCommitResult"] },
      { at: "2026-10-16T10:05:00Z", reason: "deterministic:judge-rules-refused — x", targets: ["gitStatusResult"] },
    ])].sort()).toEqual(["gitCommitResult", "gitStatusResult"]);
  });

  it("[CONTROL] a newer non-verdict record ends the run; an unanchored mention is no verdict; no records avoid nothing", async () => {
    expect(FT.targetsToAvoid([
      { at: "2026-10-24T10:00:00Z", reason: MISS, targets: ["gitStatusResult"] },
      { at: "2026-10-24T10:05:00Z", reason: "llm: the output did not report the status", targets: ["shellResult"] },
    ])).toEqual([]);
    expect(FT.targetsToAvoid([{ at: "2026-10-24T10:00:00Z", reason: `note: ${MISS}`, targets: ["gitStatusResult"] }])).toEqual([]);
    expect(FT.targetsToAvoid([])).toEqual([]);
    // a run that REACHED supersedes the misses before it (the recall's exactFailuresSince), so its targets stay eligible
    const sinceReach = exactFailuresSince([{ at: "2026-10-24T10:00:00Z", reason: MISS, targets: ["gitStatusResult"] }], "2026-10-24T10:01:00Z");
    expect(FT.targetsToAvoid(sinceReach)).toEqual([]);
    const d = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { ...llm, excludeTargets: FT.targetsToAvoid(sinceReach) } as never);
    expect(d.shapes).toEqual(["gitStatusResult"]);
  });
});
