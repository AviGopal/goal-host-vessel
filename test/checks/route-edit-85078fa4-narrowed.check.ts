import { test, describe, expect } from "bun:test";
// Import from the module where the defect lives, as a namespace, to test its exports.
import * as mod from "../../src/index";

describe("early edit-intent detection on pathless goal (route-edit-85078fa4-narrowed)", () => {
  // This goal text is taken from the defect description. It contains no file path.
  // The defect is that goals like this are incorrectly routed for code editing.
  const pathlessGoalThatTriggersDefect =
    "Add TypeSafe's Jev as a decision provider for this substrate. The API key is already in the environment as TYPESAFE_API_KEY. Do not hardcode the endpoint, model name, request format, or WHY PREVIOUS ATTEMPTS ON THIS GAP FAILED (most recent last): - anchor_not.";

  test("defect: a goal with no file path should not be considered compositional", () => {
    // The bug is that a pathless goal is misidentified as an edit/compositional goal.
    // The function `isCompositionalGoal` should return a falsy value for this input.
    // This assertion for the correct behavior will FAIL because of the defect, thus reproducing it.
    const result = mod.isCompositionalGoal(pathlessGoalThatTriggersDefect);
    expect(result).toBeFalsy();
  });

  // This is a control test to ensure that the function correctly identifies goals
  // that ARE compositional, and that this behavior is maintained after the fix.
  test("control: a goal with an explicit file path is compositional", () => {
    const compositionalGoal =
      "In repos/goal-host-vessel/src/index.ts, add a comment.";
    // This is a clear edit intent and should always be considered compositional.
    const result = mod.isCompositionalGoal(compositionalGoal);
    expect(result).toBeTruthy();
  });
});
