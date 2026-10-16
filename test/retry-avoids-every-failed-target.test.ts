// A RETRY AVOIDS EVERY TARGET IT FAILED ON, AND EVERY READER SEES THE TARGETS ACTUALLY CHOSEN (CHANGE-35 A2b-min repair).
//
// The first A2b-min recorded "the targets this attempt chose" from inferredTargetDecisionCache, which the routes wrote
// BEFORE the read rule and the retry exclusion: attempt 2, told to avoid X, chose Y, failed, and was recorded as X. And
// it avoided only the LATEST failure's targets, so attempt 3 went back to X. The same stale set reached the reach gate's
// last fallback (undoing A2a's mutation drop there) and the path record.
//
//   [MUST-FAIL] X then Y fail with no artifact -> the third attempt avoids both (targetsToAvoid over the failure run).
//   [MUST-FAIL] the FINAL decision (after exclusion) is kept under its own cache; the routes' memo keeps the unfiltered one.
//   [MUST-FAIL] the A2a read rule's drop is what the final cache holds (the reach gate's fallback reads it).
//   [CONTROL]   a newer failure of another kind ends the run; no failures avoid nothing; everything excluded -> today's
//               choice ("no alternative").
//   [WIRING]    index.ts: memo vs final cache, the failure record reads the dispatched set first, the avoid rule is the
//               shared one, the dispatched set is noted after inference and at an OR-alternative commit.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as GTI from "../src/goal-target-inference";
const FT = (await import("../src/failed-targets").catch(() => ({}))) as Record<string, any>;
const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

const KNOWN = ["gitCommitResult", "gitStatusResult", "shellResult", "webSearchResult"];
const GOAL = "Show the git status of the super-repo clone";
const llm = { complete: async () => JSON.stringify({ target_shapes: ["gitCommitResult"], alternatives: [["gitStatusResult"], ["shellResult"]] }) };
const NA = "deterministic:write-goal-no-artifact — no artifact on the target";

describe("a retry avoids every target it failed on", () => {
  it("[MUST-FAIL] X then Y fail with no artifact: attempt 3 avoids both", async () => {
    expect(typeof FT["targetsToAvoid"]).toBe("function");
    const records = [
      { at: "2026-10-16T10:00:00Z", reason: NA, targets: ["gitCommitResult"] },
      { at: "2026-10-16T10:05:00Z", reason: NA, targets: ["gitStatusResult"] },
    ];
    const avoid = FT.targetsToAvoid(records);
    expect([...avoid].sort()).toEqual(["gitCommitResult", "gitStatusResult"]);
    const a3 = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { ...llm, excludeTargets: avoid } as never);
    expect(a3.shapes).not.toContain("gitCommitResult");
    expect(a3.shapes).not.toContain("gitStatusResult");
  });

  it("[MUST-FAIL] the final decision is cached apart from the routes' unfiltered memo", async () => {
    const memo = new Map(); const final = new Map();
    const d = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { ...llm, excludeTargets: ["gitCommitResult"], decisionCache: memo, finalDecisionCache: final } as never);
    expect(d.shapes).not.toContain("gitCommitResult");
    const h = GTI.goalHashOf(GOAL);
    expect((final.get(h) as { shapes: string[] } | undefined)?.shapes).toEqual(d.shapes);
    expect((memo.get(h) as { shapes: string[] } | undefined)?.shapes).toContain("gitCommitResult");
  });

  it("[MUST-FAIL] a read goal's final cache holds the A2a drop, so the reach gate's fallback cannot see the write target", async () => {
    const final = new Map();
    const W = "What is the weather forecast for Paris tomorrow?";
    const K = ["webSearchResult", "fileEditResult"];
    const d = await GTI.inferGoalTargetDecision(W, K, { complete: async () => JSON.stringify({ target_shapes: ["fileEditResult", "webSearchResult"] }), decisionCache: new Map(), finalDecisionCache: final } as never);
    expect(d.shapes).not.toContain("fileEditResult");
    expect((final.get(GTI.goalHashOf(W)) as { shapes: string[] } | undefined)?.shapes).toEqual(d.shapes);
  });

  it("[CONTROL] another kind of failure ends the run; nothing to avoid; everything excluded keeps today's choice", async () => {
    expect(typeof FT["targetsToAvoid"]).toBe("function");
    expect(FT.targetsToAvoid([])).toEqual([]);
    expect(FT.targetsToAvoid([
      { at: "2026-10-16T10:00:00Z", reason: NA, targets: ["gitCommitResult"] },
      { at: "2026-10-16T10:05:00Z", reason: "deterministic:judge-rules-refused — x", targets: ["gitStatusResult"] },
    ])).toEqual([]);
    expect(FT.targetsToAvoid([
      { at: "2026-10-16T09:00:00Z", reason: "llm: not reached", targets: ["shellResult"] },
      { at: "2026-10-16T10:00:00Z", reason: NA, targets: ["gitCommitResult"] },
    ])).toEqual(["gitCommitResult"]);
    const lone = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { complete: async () => JSON.stringify({ target_shapes: ["gitCommitResult"] }), excludeTargets: ["gitCommitResult"] } as never);
    expect(lone.shapes).toEqual(["gitCommitResult"]);
  });

  it("[WIRING] index.ts: memo vs final cache, dispatched set first, the shared avoid rule, noted where the walk commits", () => {
    expect(SRC).toContain("decisionCache: inferredTargetRoutesMemo,");
    expect(SRC).toContain("finalDecisionCache: inferredTargetDecisionCache,");
    expect(SRC).toContain("const triedTargets = dispatchedTargetsByGoal.get(rec.hash) ?? inferredTargetDecisionCache.get(rec.hash)?.shapes;");
    expect(SRC).toContain("return targetsToAvoid(exact);");
    expect(SRC).toContain("noteDispatchedTargets(goal, seededOutputShapes);");
    expect(SRC).toContain("noteDispatchedTargets(goal, alt);");
    // the reach gate's last fallback still reads the (now FINAL) decision cache
    expect(SRC).toContain("const _wgTargets = writeEvidence.targets ?? deliverables ?? inferredTargetDecisionCache.get(goalHashOf(goal))?.shapes ?? [];");
  });
});
