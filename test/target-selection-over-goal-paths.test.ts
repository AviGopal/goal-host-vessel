// TARGET INFERENCE IS A SELECTION OVER THE POSTERIOR (A2b-proper, part 1; design approved by qa 2026-10-16 ~12:00Z).
//
// History: target inference never learned. Since f85a6d5 (06-25) no commit scored a candidate target set by its record;
// the routes and the LLM proposed a set and it was dispatched. goal_execution_paths already holds each goal class's
// path target sets and their reach counters (recordGoalPath credits them from the reach verdict). The proposed sets are
// now re-ranked by a Beta(1 + s, 1 + f) draw over the rows whose recorded set contains them.
//
//   [MUST-FAIL] a goal class whose target X failed 3x and Y reached 2x picks Y (>= 90% of 500 draws; P ~ 0.972), both
//               in the pure selector and through inference given the posterior.
//   [CONTROL]   no recorded row for any candidate -> the SAME decision object (today's choice); a set the routes did not
//               propose is never chosen, however good its record; on a read goal a mutation-shaped set is never a
//               candidate (the A2a rule applies first, so the primary is never emptied); the counterfactual carries
//               every candidate's (s, f, draw).
import { describe, expect, it } from "bun:test";
import * as GTI from "../src/goal-target-inference";
const G = GTI as Record<string, any>;

const KNOWN = ["gitCommitResult", "gitStatusResult", "shellResult", "webSearchResult"];
const GOAL = "Show the git status of the super-repo clone";
const llm = { complete: async () => JSON.stringify({ target_shapes: ["gitCommitResult"], alternatives: [["gitStatusResult"]] }) };
const ROWS = [
  { expected_output_shapes: ["gitCommitResult"], successful_executions: 0, failed_executions: 3 },
  { expected_output_shapes: ["gitStatusResult", "shellResult"], successful_executions: 2, failed_executions: 0 },
];

describe("target inference selects over the posterior", () => {
  it("[MUST-FAIL] X failed 3x, Y reached 2x: the pure selector picks Y in >= 90% of 500 draws", () => {
    expect(typeof G["selectTargetSet"]).toBe("function");
    const d = { shapes: ["gitCommitResult"], confidence: 0.7, alternatives: [["gitStatusResult"]] };
    let y = 0;
    for (let i = 0; i < 500; i++) if (G.selectTargetSet(d, ROWS).decision.shapes.includes("gitStatusResult")) y++;
    expect(y).toBeGreaterThanOrEqual(450);
  });

  it("[MUST-FAIL] through inference, given the goal class's paths, Y is chosen in >= 85 of 100 runs", async () => {
    let y = 0;
    for (let i = 0; i < 100; i++) {
      const r = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { ...llm, targetPosterior: ROWS } as never);
      if (r.shapes.includes("gitStatusResult") && !r.shapes.includes("gitCommitResult")) y++;
    }
    expect(y).toBeGreaterThanOrEqual(85);
  });

  it("[CONTROL] no row for any candidate: the same decision object; the counterfactual lists every candidate", () => {
    expect(typeof G["selectTargetSet"]).toBe("function");
    const d = { shapes: ["gitCommitResult"], confidence: 0.7, alternatives: [["gitStatusResult"]] };
    const sel = G.selectTargetSet(d, [{ expected_output_shapes: ["webSearchResult"], successful_executions: 9, failed_executions: 0 }]);
    expect(sel.decision).toBe(d);
    expect(sel.changed).toBe(false);
    expect(sel.candidates.map((c: { shapes: string[] }) => c.shapes)).toEqual([["gitCommitResult"], ["gitStatusResult"]]);
    const hot = G.selectTargetSet(d, ROWS);
    for (const c of hot.candidates) { expect(typeof c.s).toBe("number"); expect(typeof c.f).toBe("number"); expect(c.draw).toBeGreaterThan(0); }
  });

  it("[CONTROL] a set the routes did not propose is never chosen, however good its record", async () => {
    const onlyX = { complete: async () => JSON.stringify({ target_shapes: ["gitCommitResult"] }) };
    const rows = [...ROWS, { expected_output_shapes: ["webSearchResult"], successful_executions: 50, failed_executions: 0 }];
    for (let i = 0; i < 20; i++) {
      const r = await GTI.inferGoalTargetDecision(GOAL, KNOWN, { ...onlyX, targetPosterior: rows } as never);
      expect(r.shapes).toEqual(["gitCommitResult"]);
    }
  });

  it("[CONTROL] on a read goal, a mutation-shaped set is never a candidate: the read rule applies first", async () => {
    const W = "What is the weather forecast for Paris tomorrow?";
    const K = ["webSearchResult", "fileEditResult"];
    const c = { complete: async () => JSON.stringify({ target_shapes: ["webSearchResult"], alternatives: [["fileEditResult"]] }) };
    const rows = [{ expected_output_shapes: ["fileEditResult"], successful_executions: 40, failed_executions: 0 }, { expected_output_shapes: ["webSearchResult"], successful_executions: 0, failed_executions: 40 }];
    for (let i = 0; i < 20; i++) {
      const r = await GTI.inferGoalTargetDecision(W, K, { ...c, targetPosterior: rows } as never);
      expect(r.shapes).toEqual(["webSearchResult"]);
    }
  });
});
