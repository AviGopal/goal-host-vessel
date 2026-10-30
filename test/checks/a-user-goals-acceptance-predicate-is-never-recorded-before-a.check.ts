import { describe, test, expect } from "bun:test";

describe("user goal acceptance predicate", () => {
  test("is inferred from the goal, not self-confirmed from the walk's output", async () => {
    // Ensure the module can load in isolation without external wiring.
    if (!process.env.LLM_VESSEL_ENDPOINT) {
      process.env.LLM_VESSEL_ENDPOINT = "http://127.0.0.1:8220";
    }

    // Dynamic import to avoid load-time side effects before env is set.
    // Dynamic import to avoid load-time side effects before env is set.
    const mod = await import("../../src/index");

    // This goal text implies that 'shellResult' is the shape that signals completion.
    const goal = "Run a shell command and show the result";

    // Simulate a walk that produced no shapes.
    const producedShapes: string[] = [];
    const taskSummary = "Walk failed to produce any shapes.";

    // verifyGoalReached simulates the judge. The defect is that it infers
    // completion_shapes from its `producedShapes` argument, not from the goal.
    let verdict: unknown;
    try {
      verdict = await mod.verifyGoalReached(
        goal,
        producedShapes,
        taskSummary
      );
    } catch {
      // If the site under test throws (e.g. due to unrelated env), assert on undefined so the
      // failure is an expect(...) mismatch, not a thrown error.
      verdict = undefined;
    }

    // With a fix, the judge should infer from the goal that 'shellResult' was
    // the acceptance predicate. It would then correctly fail the goal because
    // that shape was not in producedShapes. The verdict should record the
    // predicate it used.
    // Currently, this fails: completionShapes is inferred from the empty
    // producedShapes, so the verdict's completionShapes will be [].
    expect((verdict as { completionShapes?: string[] } | undefined)?.completionShapes).toEqual(["shellResult"]);
  });

  test("CONTROL: when producedShapes match goal's predicate, verdict is reached with correct shapes", async () => {
    // Ensure the module can load in isolation without external wiring.
    if (!process.env.LLM_VESSEL_ENDPOINT) {
      process.env.LLM_VESSEL_ENDPOINT = "http://127.0.0.1:8220";
    }

    // Dynamic import to avoid load-time side effects before env is set.
    const mod = await import("../../src/index");

    const goal = "Run a shell command and show the result";

    // Simulate a walk that produced the shape implied by the goal.
    const producedShapes = ["shellResult"];
    const taskSummary = "Walk produced shellResult.";

    let verdict: unknown;
    try {
      verdict = await mod.verifyGoalReached(
        goal,
        producedShapes,
        taskSummary
      );
    } catch {
      verdict = undefined;
    }

    const verdictRecord = verdict as { reached?: boolean; completionShapes?: string[] } | undefined;

    // This should pass now (self-confirming) and after the fix (correctly inferred).
    expect(verdictRecord?.completionShapes).toEqual(["shellResult"]);
    // Because producedShapes contains the completionShape, the goal is reached.
    expect(verdictRecord?.reached).toBe(true);
  });
});
