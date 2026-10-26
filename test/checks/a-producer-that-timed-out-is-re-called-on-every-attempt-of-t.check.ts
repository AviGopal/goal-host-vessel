import { expect, test } from "bun:test";
import * as mod from "../../src/index.js";

test("a producer that returns a dishonest body is not re-selected in the same dispatch", () => {
  const goalText = "test goal";
  const walkLog: readonly unknown[] = [
    {
      pick: "producer-that-failed",
      reason: "DISHONEST body ... refusing to satisfy",
    },
  ];
  const finalReason = "DISHONEST body ... refusing to satisfy";
  const pick = "producer-that-failed";
  const shapes = ["some-shape"];
  const attempts = 2;

  const failureReasons = mod.rememberDispatchFailures(
    goalText,
    walkLog,
    finalReason,
    pick,
    shapes,
    attempts
  );

  expect(failureReasons).toContain("unreachable producer: producer-that-failed");
});
