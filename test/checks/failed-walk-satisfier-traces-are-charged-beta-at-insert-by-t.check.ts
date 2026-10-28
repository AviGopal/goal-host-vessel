import { describe, test, expect, spyOn, afterEach } from "bun:test";
import * as mod from "../../src/index";

// Mock `fetch` to intercept the external call to persist the trace.
// The bug is in the payload of this call, which this mock captures.
let postedTrace: any = null;
const fetchSpy = spyOn(global, "fetch").mockImplementation(async (url, options) => {
  if (String(url).includes("execution-traces") && options?.body) {
    try {
      postedTrace = JSON.parse(options.body as string);
    } catch (e) {
      console.error("Failed to parse fetch body in mock");
    }
  }
  return new Response(JSON.stringify({ id: "trace-id-mock" }), { status: 200 });
});

afterEach(() => {
  fetchSpy.mockClear();
  postedTrace = null;
});

describe("failed walk satisfier traces", () => {
  test("are persisted with task_count when tasks are present, to prevent beta=1 mis-charge", async () => {
    // Arrange
    const goalText = "A goal that fails with tasks";
    const walkLog = [
      {
        executionId: "exec_id_1",
        tasks: [
          {
            taskId: "task_id_1",
            resolverId: "test.resolver",
            success: false,
            reason: "Task failed for test",
          },
        ],
        reached: false,
      },
    ];

    // Act: rememberDispatchFailures triggers a fire-and-forget persistence call.
    mod.rememberDispatchFailures(goalText, walkLog, "Walk failed", "test-template", ["output.shape"], 1);
    // Wait for the async `fetch` call to be made.
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Assert
    expect(fetchSpy).toHaveBeenCalled();
    expect(postedTrace).not.toBeNull();
    expect(postedTrace.tasks).toBeArray();
    const taskCount = postedTrace.tasks.length;
    expect(taskCount).toBeGreaterThan(0);

    // FAILING ASSERTION: The bug is that `task_count` is not sent, making `postedTrace.task_count` undefined.
    // The correct behavior is for it to be equal to the number of tasks.
    expect(postedTrace.task_count).toBe(taskCount);
  });

  test("CONTROL: are persisted without requiring task_count when no tasks are present", async () => {
    // Arrange
    const goalText = "A goal that fails without tasks";
    const walkLogWithNoTasks = [
      {
        executionId: "exec_id_2",
        tasks: [], // No tasks
        reached: false,
      },
    ];

    // Act
    mod.rememberDispatchFailures(goalText, walkLogWithNoTasks, "Walk failed", "test-template", ["output.shape"], 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Assert
    expect(fetchSpy).toHaveBeenCalled();
    expect(postedTrace).not.toBeNull();

    if (postedTrace.tasks) {
      expect(postedTrace.tasks.length).toBe(0);
    }

    // Correct behavior: if task_count is present, it should be 0. If it's absent, that's also fine.
    // This test should pass before and after the fix.
    if (postedTrace.task_count !== undefined) {
      expect(postedTrace.task_count).toBe(0);
    }
  });
});
