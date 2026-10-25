import { describe, test, expect } from "bun:test";
import * as mod from "../../src/compose-gap-id";

describe("gapIdOfGoalText", () => {
  test("should extract gap ID from a reworded investigation goal", () => {
    const gapId = "a-real-gap-id-from-prose";
    // This goal is reworded and won't match the strictly-anchored regex in gapIdOfGoalText.
    const rewordedGoal = `Could you please investigate and decompose gap ${gapId}: this is a test.`;

    // The current implementation will incorrectly return a 'route-edit-<hash>' string.
    const extractedId = mod.gapIdOfGoalText(rewordedGoal);

    // This assertion checks for the correct behavior. It will fail, reproducing the bug.
    expect(extractedId).toBe(gapId);
  });
});
