import { describe, test, expect } from "bun:test";
import * as GoalHost from "../../src/index";

describe("an edit goal whose compose route fails falls through to a walk", () => {
  // Based on the spec, when an edit-intent goal's early route to feature_compose fails,
  // it falls through to a regular walk. The defect is that this walk incorrectly
  // processes shapes like `fileEditResult`, leading to malformed writes.
  // The function `floorJudgedShapes` is implicated, as it decides which shapes from
  // the walk are passed on for judgement. The buggy logic at src/index.ts:3827
  // causes `fileEditResult` to be considered a meaningful write on its own, when it shouldn't be.
  test("failing: a walk targeting only fileEditResult should not be judged as a meaningful write, returning []", () => {
    const targetShapes = ["fileEditResult"];
    const calledWriteShapes = new Set<string>(); // No explicit write tool was called
    const executed: ReadonlyArray<{ tool: string; ok: boolean }> = []; // No tools executed

    const judgedShapes = GoalHost.floorJudgedShapes(
      targetShapes,
      calledWriteShapes,
      executed
    );

    // The defect causes `fileEditResult` to be returned, leading to incorrect processing.
    // The correct behavior is to return an empty array because `fileEditResult` alone is not
    // a sufficient, verifiable write without other accompanying shapes or tool calls.
    expect(judgedShapes).toEqual([]);
  });

  // This control test demonstrates that a legitimate, verifiable write shape like
  // `gitCommitResult` is correctly identified for judgement. This behavior should
  // remain unchanged after the fix.
  test("control: a walk with a concrete, verifiable write shape is correctly judged", () => {
    const targetShapes = ["gitCommitResult"];
    // Emulating a scenario where a git commit tool was called and produced the shape.
    const calledWriteShapes = new Set<string>(["gitCommitResult"]);
    const executed: ReadonlyArray<{ tool: string; ok: boolean }> = [
      { tool: "git:commit", ok: true },
    ];

    const judgedShapes = GoalHost.floorJudgedShapes(
      targetShapes,
      calledWriteShapes,
      executed
    );

    // A shape like gitCommitResult is a verifiable write and should be judged.
    expect(judgedShapes).toEqual(["gitCommitResult"]);
  });
});
