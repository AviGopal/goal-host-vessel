// A RETRY NEVER DROPS A TARGET THE GOAL'S OWN WORDS DEMAND (qa review of "a repeated failing goal can change course").
// Once the floor-wrapped no-artifact record continued the run, the exclusion FIRED, and its only guard was a gap
// investigation's gapDecomposition. qa's probe: "Summarise the three oldest open substrate gaps and record a concept
// capturing the summary", targets [substrateGap, concept_write], one floor-wrapped no-artifact record: both were
// excluded, the routes were re-asked, and the retry ran on [llmCompletion]. The reach gate counts only a write on one of
// the goal's own targets (judge-rules/write-goal.ts artifactWrites), so that retry could never reach.
//
//   [MUST-FAIL] qa's probe: concept_write stays in the retry's targets.
//   [MUST-FAIL] a verbatim read's fileContent is not excluded and the routes are not re-asked.
//   [MUST-FAIL] a graded verdict that QUOTES "HTTP 500" in its prose is a content failure.
//   [CONTROL]   in qa's probe the non-demanded failed target (substrateGap) is still excluded (P4's purpose); a reported
//               transport 5xx is still infrastructure; a structural deterministic reason stays structural.
import { describe, expect, it } from "bun:test";
import * as GTI from "../src/goal-target-inference";
import * as FT from "../src/failed-targets";

const NA = "deterministic:write-goal-no-artifact — the goal asks for a write (targets [substrateGap, concept_write]), and a change/write goal is reached only by a landed sha or a persisted write of its own target; this run persisted no write and landed nothing, so a plan or prose answer cannot reach it";
const FLOOR_NA = `floor floor:upstream-not-reached: ${NA}`;

function stub(answers: string[]) {
  const prompts: string[] = [];
  return { prompts, complete: async (p: string) => { prompts.push(p); return answers[Math.min(prompts.length - 1, answers.length - 1)]!; } };
}

describe("a retry never drops a target the goal's own words demand", () => {
  it("[MUST-FAIL + CONTROL] qa's probe: concept_write stays; the failed substrateGap is still excluded", async () => {
    const GOAL = "Summarise the three oldest open substrate gaps and record a concept capturing the summary";
    const KNOWN = ["substrateGap", "concept_write", "llmCompletion", "memoryNote_write", "shellResult"];
    const records = [{ at: "2026-10-17T10:00:00Z", reason: FLOOR_NA, targets: ["substrateGap", "concept_write"] }];
    const excludeTargets = FT.targetsToAvoid(records);
    expect(excludeTargets).toEqual(["substrateGap", "concept_write"]);
    const llm = stub([
      JSON.stringify({ target_shapes: ["substrateGap", "concept_write"], alternatives: [] }),
      JSON.stringify({ target_shapes: ["llmCompletion"], alternatives: [] }),
    ]);
    const d = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { complete: llm.complete, excludeTargets, failureRows: FT.failureRowsFrom(records) } as never);
    expect(d.shapes).toContain("concept_write");
    expect(d.shapes).not.toContain("substrateGap");
    expect(d.target_selection?.excluded).toEqual(["substrateGap"]);
  });

  it("[MUST-FAIL] a verbatim read's fileContent is not excluded and the routes are not re-asked", async () => {
    const GOAL = "Print /workspace/docs/plan.txt verbatim";
    const llm = stub([JSON.stringify({ target_shapes: ["shellResult"], alternatives: [] })]);
    // Positive control: with nothing excluded the verbatim shortcut answers fileContent and the chooser is not asked.
    expect((await GTI.inferGoalTargetDecision(GOAL, ["fileContent", "shellResult"], { complete: llm.complete } as never)).shapes).toEqual(["fileContent"]);
    expect(llm.prompts.length).toBe(0);
    const d = await GTI.inferGoalTargetDecision(GOAL, ["fileContent", "shellResult"], { complete: llm.complete, excludeTargets: ["fileContent"] } as never);
    expect(d.shapes).toEqual(["fileContent"]);
    expect(llm.prompts.length).toBe(0);
  });

  it("[MUST-FAIL] a graded verdict that quotes HTTP 500 in its prose is a content failure", () => {
    const quoted = "deterministic:artifact-not-written — the goal named /workspace/out.json; the answer says fs_edit returned HTTP 500 \"path outside workspace root\" and the file does not exist";
    expect(FT.failureInvalidatesTargetMemo(quoted)).toBe(true);
    expect(FT.failureInvalidatesTargetMemo(`floor floor:upstream-not-reached: ${quoted}`)).toBe(true);
  });

  it("[CONTROL] a reported transport 5xx is still infrastructure; a structural deterministic reason stays structural", () => {
    expect(FT.failureInvalidatesTargetMemo("shellResult resolve failed: HTTP 503")).toBe(false);
    expect(FT.failureInvalidatesTargetMemo("HTTP 500 from llm-vessel")).toBe(false);
    expect(FT.failureInvalidatesTargetMemo("resolve_shellResult(local-tools): shellResult via local-tools HTTP 503: busy")).toBe(false);
    expect(FT.failureInvalidatesTargetMemo("deterministic:hollow_walklog_capped — 3 gaps filed")).toBe(false);
    expect(FT.failureInvalidatesTargetMemo(NA)).toBe(true);
  });
});
