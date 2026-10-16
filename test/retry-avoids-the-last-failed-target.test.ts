// A RETRIED GOAL DOES NOT CHOOSE AGAIN THE TARGET IT JUST FAILED ON (CHANGE-35 / A2b-minimal).
//
// User ruling (qa session, 2026-10-16 ~09:51:41Z): "a retried goal whose last attempt failed 'no artifact on target X'
// must not choose X again; the failure class is shaped input to the next target choice." RUN 0: with learning on, both
// attempts of the same goals chose the same targets and failed the same way. goal-host's EXISTING failure memory now
// keeps each failed attempt's targets; when the latest failure since the last reach is write-goal-no-artifact, the next
// inference is told to avoid them (applied after every route and the vocabulary filter).
//
//   [MUST-FAIL] the same goal twice: attempt 2, told to avoid attempt 1's failed target, infers a set that differs and
//               excludes it.
//   [CONTROL]   no prior failure (nothing to avoid): unchanged; exclusion that would empty the set keeps today's choice
//               ("no alternative"); a primary set emptied by exclusion falls back to the best alternative.
//   [CONTROL]   wiring: the failure record keeps the attempt's targets; only a LATEST write-goal-no-artifact since the
//               last reach is avoided (a reach supersedes); the inference call passes it.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as GTI from "../src/goal-target-inference";

const KNOWN = ["gitCommitResult", "gitStatusResult", "shellResult", "webSearchResult"];
const GOAL = "Show the git status of the super-repo clone";
const llm = { complete: async () => JSON.stringify({ target_shapes: ["gitCommitResult", "shellResult"] }) };
const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("a retry avoids the target it just failed on", () => {
  it("[MUST-FAIL] attempt 2 excludes attempt 1's failed target", async () => {
    const a1 = await GTI.inferGoalTargetDecision(GOAL, KNOWN, llm);
    expect(a1.shapes).toContain("gitCommitResult");
    const a2 = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { ...llm, excludeTargets: ["gitCommitResult"] } as never);
    expect(a2.shapes).not.toContain("gitCommitResult");
    expect(a2.shapes).not.toEqual(a1.shapes);
  });

  it("[CONTROL] nothing to avoid is unchanged; no alternative keeps today's choice; an alternative is used", () => {
    const f = (GTI as Record<string, any>)["withoutFailedTargets"];
    expect(typeof f).toBe("function");
    const d = { shapes: ["a_write"], confidence: 0.8, alternatives: [["b"]] };
    expect(f(d, [])).toBe(d);
    expect(f(d, undefined)).toBe(d);
    expect(f(d, ["a_write"]).shapes).toEqual(["b"]);
    const lone = { shapes: ["a_write"], confidence: 0.8, alternatives: [] };
    expect(f(lone, ["a_write"])).toBe(lone);
  });

  it("[CONTROL] wiring: targets recorded, only a latest no-artifact failure since the last reach is avoided, and passed", () => {
    expect(SRC).toContain("const triedTargets = dispatchedTargetsByGoal.get(rec.hash) ?? inferredTargetDecisionCache.get(rec.hash)?.shapes;");
    expect(SRC).toMatch(/function failedTargetsToAvoid\(goalText: string\): string\[\] \{\n  const \{ exact \} = recallGoalFailures\(goalText\);/);
    // the rule is the shared one (src/failed-targets.ts targetsToAvoid: the unbroken run of latest no-artifact failures)
    expect(SRC).toContain("return targetsToAvoid(exact);");
    expect(SRC).toContain("excludeTargets: _avoidTargets,");
  });
});
