import { test, expect, describe, afterEach } from "bun:test";
import * as mod from "../../src/index";

describe("dispatch record learning mode defect", () => {
  // The executionStore is a module-level global that persists state between runs.
  // We must clear it after each test to ensure test isolation.
  afterEach(() => {
    const store = (mod.dispatchContext as any).executionStore;
    if (store && typeof store.clear === "function") {
      store.clear();
    }
  });

  test("MUST-FAIL: dispatch record should carry learningMode 'observe' when run in observe mode", async () => {
    const goal = "a simple goal that triggers a walk to test learning mode recording";
    const request = new Request("http://localhost/run-goal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal,
        variables: { learning_mode: "observe" },
      }),
    });

    // Execute a goal walk by calling the exported handler. This populates the dispatch store.
    const response = await mod.handleRunGoal(request);
    const result = (await response.json()) as { execution_id: string };
    const executionId = result.execution_id;

    expect(typeof executionId).toBe("string");

    // Retrieve the resulting dispatch record from the store via the exported dispatchContext.
    const executionStore = (mod.dispatchContext as any).executionStore;
    const record = executionStore.get(executionId);

    // Verify we're on the correct code path: learning occurred and was recorded.
    // This connects the test to the evidence line in src/index.ts.
    expect(record.learning).toBeDefined();
    expect(record.learning.goalPathRecorded).toBe(true);

    // This is the failing assertion that reproduces the bug. The `learningMode`
    // property is missing from the record, so `record.learningMode` is undefined.
    expect(record.learningMode).toBe("observe");
  });

  test("CONTROL: dispatch record correctly includes what was taught (the 'learning' object)", async () => {
    const goal = "a simple goal for the control test to ensure existing behavior is preserved";
    const request = new Request("http://localhost/run-goal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal,
        variables: { learning_mode: "observe" },
      }),
    });

    // Execute a goal walk, same as the failing test.
    const response = await mod.handleRunGoal(request);
    const result = (await response.json()) as { execution_id: string };
    const executionId = result.execution_id;

    expect(typeof executionId).toBe("string");

    // Retrieve the record.
    const executionStore = (mod.dispatchContext as any).executionStore;
    const record = executionStore.get(executionId);

    // This behavior is correct and must pass before and after the fix.
    // The 'learning' object itself is present, even if the top-level 'learningMode' is not.
    expect(record.learning).toBeDefined();
    expect(record.learning.goalPathRecorded).toBe(true);
    expect(record.goal).toBe(goal);
  });
});
