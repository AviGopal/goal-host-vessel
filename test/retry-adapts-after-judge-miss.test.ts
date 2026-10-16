// J4: A RETRY AFTER A JUDGE-GRADED MISS ADAPTS (user ruling 2026-10-16T22:56:41Z, J1-J4). Target selection (A2b-proper)
// reads the goal class's recorded paths, but a probe runs with learningMode "observe", where no path is recorded: attempt 2
// re-ran attempt 1's inference and chose the same targets. The failure memory is kept in every mode; its records since the
// goal's last reach are offered to the selection as failure rows of the targets each failed under, ONLY in observe mode
// (with learning on the posterior already holds every attempt, and adding them would count one miss twice).
//
//   [MUST-FAIL] attempt 1's target T was graded hollow by the judge: on attempt 2 the selection prefers the untried
//               alternative (deterministic mean draw), and through inference P(choose T) drops below the cold choice.
//   [PARAPHRASE] a reworded goal of the same failure record behaves the same (the record, not the wording, is read).
//   [HELD-OUT]  no failure records: the decision is byte-identical to the cold start (the same object).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as GTI from "../src/goal-target-inference";
import { failureRowsFrom } from "../src/failed-targets";

const KNOWN = ["gitCommitResult", "gitStatusResult", "shellResult", "webSearchResult"];
const llm = { complete: async () => JSON.stringify({ target_shapes: ["gitCommitResult"], alternatives: [["gitStatusResult"]] }) };
const judgeMiss = [{ at: "2026-10-16T23:00:00Z", reason: "llm: the answer does not report the status", targets: ["gitCommitResult"] }];
const mean = (a: number, b: number) => a / (a + b);

describe("J4: a retry after a judge-graded miss adapts", () => {
  it("[UNIT] failure records become rows of the targets each failed under (failed once); records without targets give none", () => {
    expect(failureRowsFrom(judgeMiss)).toEqual([{ expected_output_shapes: ["gitCommitResult"], successful_executions: 0, failed_executions: 1 }]);
    expect(failureRowsFrom([{ at: "x", reason: "r" }])).toEqual([]);
  });

  it("[MUST-FAIL] the selection prefers the untried alternative over the target the judge just graded hollow", () => {
    const d = { shapes: ["gitCommitResult"], confidence: 0.7, alternatives: [["gitStatusResult"]] };
    expect(GTI.selectTargetSet(d, failureRowsFrom(judgeMiss), mean).decision.shapes).toEqual(["gitStatusResult"]);
  });

  it("[MUST-FAIL] through inference (observe mode's failure rows), P(choose the failed target) drops below the cold choice", async () => {
    let cold = 0, warm = 0;
    for (let i = 0; i < 200; i++) {
      if ((await GTI.inferGoalTargetDecision("Show the git status of the super-repo clone", KNOWN, { ...llm } as never)).shapes.includes("gitCommitResult")) cold++;
      if ((await GTI.inferGoalTargetDecision("Show the git status of the super-repo clone", KNOWN, { ...llm, failureRows: failureRowsFrom(judgeMiss) } as never)).shapes.includes("gitCommitResult")) warm++;
    }
    expect(cold).toBe(200);
    expect(warm).toBeLessThan(150); // P(T) = P(Beta(1,2) > Beta(1,1)) = 1/3
  });

  it("[PARAPHRASE] a reworded goal with the same failure record behaves the same", async () => {
    let warm = 0;
    for (let i = 0; i < 200; i++) if ((await GTI.inferGoalTargetDecision("What does git status say for the super-repo clone right now?", KNOWN, { ...llm, failureRows: failureRowsFrom(judgeMiss) } as never)).shapes.includes("gitCommitResult")) warm++;
    expect(warm).toBeLessThan(150);
  });

  it("[HELD-OUT] no failure records: the decision is the cold-start decision", () => {
    const d = { shapes: ["gitCommitResult"], confidence: 0.7, alternatives: [["gitStatusResult"]] };
    expect(GTI.selectTargetSet(d, failureRowsFrom([])).decision).toBe(d);
  });

  it("[WIRING] the walk passes failure rows ONLY in observe mode (learning mode reads the posterior alone: no double count)", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).toContain('...(opts.learningMode === "observe" ? { failureRows: failureRowsFrom(recallGoalFailures(goal).exact) } : {}),');
  });
});
