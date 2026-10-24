import { test, expect } from "bun:test";
import * as intent from "../../src/goal-intent";
import { verifyGoalReached } from "../../src/index.js";

// Repro: src/goal-intent.ts comment claims `verifyGoalReached` is unexported.
// This check imports the edit site (goal-intent) and makes a benign call into it,
// then asserts the comment's claim — expecting `verifyGoalReached` to be undefined.
// Because src/index.ts actually exports it, this assertion fails for the right reason.

test("a source comment asserts verifyGoalReached is unexported, but it is exported from index", () => {
  // Anchor on the edit site: call an exported function with valid args and assert on its return type.
  const normalized: string = intent.canonicalGoalText("  Edit repos/foo/bar.ts ");
  expect(typeof normalized).toBe("string");

  // The misleading claim we are checking: expect it to be unexported (undefined).
  // This is FALSE in code (it is exported via src/index.ts), so this expect fails.
  expect(typeof verifyGoalReached).toBe("undefined");
});
