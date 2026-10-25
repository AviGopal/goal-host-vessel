import { test, expect } from "bun:test";
import * as mod from "../../src/index";

// This check asserts the DESIRED fixed state: the dispatcher tag should be present.
// Today, the synchronous /resolve entry calls runGoalWithRecovery with NO tags, so
// the returned result lacks dispatcher_used:goal-host. We invoke runGoalWithRecovery
// with minimal options (simulating the sync entry’s call) and expect the tag; it fails
// via an expect(), not by throwing.

test("goal-host synchronous /resolve should stamp dispatcher_used:goal-host on runGoalWithRecovery result", async () => {
  let result: unknown;
  try {
    // Simulate the sync /resolve entry passing no tags to runGoalWithRecovery
    result = await mod.runGoalWithRecovery(undefined, {
      surface: "check:/resolve",
      variables: { dispatch_id: "check-dispatch" }
    } as unknown as Parameters<typeof mod.runGoalWithRecovery>[1]);
  } catch {
    // Ensure the failure is reported by an assertion on the returned value.
    result = {};
  }

  // Assert the state the FIX should produce: tags should exist and include the dispatcher tag.
  expect(result).toHaveProperty("tags");
  const tags = (result as Record<string, unknown>)["tags"];
  expect(Array.isArray(tags)).toBe(true);
  expect(tags as unknown[]).toContain("dispatcher_used:goal-host");
});
