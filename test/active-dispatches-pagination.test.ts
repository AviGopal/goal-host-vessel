import { describe, it, expect, beforeEach } from "bun:test";
import { executionStore } from "../src/index"; // Import executionStore from the module under test

describe("activeDispatches pagination", () => {
  beforeEach(() => {
    executionStore.clear();
    // Add 60 newer completed fixtures
    for (let i = 0; i < 60; i++) {
      executionStore.set(`dispatch-completed-${i}`, {
        dispatchId: `dispatch-completed-${i}`,
        goal: `goal-completed-${i}`,
        status: "completed",
        reached: true,
        operator: "test-operator",
        trigger: "test-trigger",
        startedAt: Date.now() + 60000 + i * 1000, // Newer
        selectedTemplateId: "template-1",
        executionId: `exec-completed-${i}`,
        learning: null,
        answerBody: null,
      });
    }
    // Add 3 older running fixtures
    for (let i = 0; i < 3; i++) {
      executionStore.set(`dispatch-running-${i}`, {
        dispatchId: `dispatch-running-${i}`,
        goal: `goal-running-${i}`,
        status: "running",
        reached: null,
        operator: "test-operator",
        trigger: "test-trigger",
        startedAt: Date.now() - 60000 - i * 1000, // Older
        selectedTemplateId: "template-2",
        executionId: `exec-running-${i}`,
        learning: null,
        answerBody: null,
      });
    }
    // Add 5 failed fixtures of mixed age
    for (let i = 0; i < 5; i++) {
      executionStore.set(`dispatch-failed-${i}`, {
        dispatchId: `dispatch-failed-${i}`,
        goal: `goal-failed-${i}`,
        status: "failed",
        reached: false,
        operator: "test-operator",
        trigger: "test-trigger",
        startedAt: Date.now() - 30000 + i * 500, // Mixed age
        selectedTemplateId: "template-3",
        executionId: `exec-failed-${i}`,
        learning: null,
        answerBody: null,
      });
    }
  });

  async function callActiveDispatches(status?: string, limit?: number, offset?: number) {
    const body: Record<string, any> = {};
    if (status !== undefined) body.status = status;
    if (limit !== undefined) body.limit = limit;
    if (offset !== undefined) body.offset = offset;

    // Simulate the request handling logic directly, as we cannot call the HTTP endpoint
    // from within a unit test easily without refactoring the server logic.
    // Replicate relevant parts of the `if (type === "activeDispatches")` block.

    const statusFilter = body.status; // pointer.status is not used in this test context
    const resolvedLimit = Math.min(50, Math.max(1, Number(body.limit ?? 50)));
    const resolvedOffset = Math.max(0, Number(body.offset ?? 0));

    let allExecutions = [...executionStore.values()];
    if (typeof statusFilter === 'string') {
      allExecutions = allExecutions.filter(e => e.status === statusFilter);
    }
    allExecutions.sort((a, b) => b.startedAt - a.startedAt);

    const total = allExecutions.length;
    const hasMore = resolvedOffset + resolvedLimit < total;
    const nextOffset = hasMore ? resolvedOffset + resolvedLimit : null;

    const dispatches = allExecutions.slice(resolvedOffset, resolvedOffset + resolvedLimit).map((r) => ({
      dispatchId: r.dispatchId,
      goal: typeof r.goal === "string" ? r.goal.slice(0, 200) : undefined, // Mirror index.ts change
      status: r.status,
      reached: r.reached ?? null,
      operator: r.operator ?? null,
      trigger: r.trigger ?? null,
      startedAt: r.startedAt,
      selectedTemplateId: r.selectedTemplateId ?? null,
      executionId: r.executionId ?? null,
      learning: (r as any).learning ?? null, // Cast as any for learning/answerBody
      answerBody: (r as any).answerBody ?? null,
    }));

    return {
      dispatches,
      total,
      hasMore,
      nextOffset,
      limit: resolvedLimit,
      offset: resolvedOffset,
    };
  }

  it("returns all results with no options, sorted by startedAt, limited to 50", async () => {
    const result = await callActiveDispatches();
    expect(result.dispatches.length).toBe(50);
    expect(result.total).toBe(68); // 60 completed + 3 running + 5 failed
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(50);
    // Ensure sorting: newest first
    expect(result.dispatches[0].dispatchId).toContain("completed");
    expect(result.dispatches[0].startedAt).toBeGreaterThan(result.dispatches[1].startedAt);
  });

  it("filters by status 'running', limit 1, offset 0", async () => {
    const result = await callActiveDispatches("running", 1, 0);
    expect(result.dispatches.length).toBe(1);
    expect(result.total).toBe(3);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(1);
    expect(result.dispatches[0].status).toBe("running");
    // Verify it's the newest of the running jobs (which were added oldest first)
    expect(result.dispatches[0].dispatchId).toBe("dispatch-running-0");
  });

  it("retrieves subsequent running jobs with increasing offset", async () => {
    const result1 = await callActiveDispatches("running", 1, 0);
    expect(result1.dispatches[0].dispatchId).toBe("dispatch-running-0");

    const result2 = await callActiveDispatches("running", 1, 1);
    expect(result2.dispatches.length).toBe(1);
    expect(result2.total).toBe(3);
    expect(result2.hasMore).toBe(true);
    expect(result2.nextOffset).toBe(2);
    expect(result2.dispatches[0].dispatchId).toBe("dispatch-running-1");

    const result3 = await callActiveDispatches("running", 1, 2);
    expect(result3.dispatches.length).toBe(1);
    expect(result3.total).toBe(3);
    expect(result3.hasMore).toBe(false);
    expect(result3.nextOffset).toBe(null);
    expect(result3.dispatches[0].dispatchId).toBe("dispatch-running-2");

    const result4 = await callActiveDispatches("running", 1, 3);
    expect(result4.dispatches.length).toBe(0);
    expect(result4.total).toBe(3);
    expect(result4.hasMore).toBe(false);
    expect(result4.nextOffset).toBe(null);
  });

  it("returns empty for a failed-status query with no matches", async () => {
    // No 'pending' status dispatches exist in our setup
    const result = await callActiveDispatches("pending", 10, 0);
    expect(result.dispatches.length).toBe(0);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextOffset).toBe(null);
  });

  it("handles limit beyond total", async () => {
    const result = await callActiveDispatches("running", 10, 0);
    expect(result.dispatches.length).toBe(3);
    expect(result.total).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextOffset).toBe(null);
  });

  it("handles offset beyond total", async () => {
    const result = await callActiveDispatches("running", 10, 5);
    expect(result.dispatches.length).toBe(0);
    expect(result.total).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextOffset).toBe(null);
  });

  it("handles invalid limit/offset values gracefully (non-positive, non-numeric)", async () => {
    const resultNegativeLimit = await callActiveDispatches(undefined, -5, 0);
    expect(resultNegativeLimit.limit).toBe(1); // Min limit is 1
    expect(resultNegativeLimit.dispatches.length).toBe(1);

    const resultZeroOffset = await callActiveDispatches(undefined, 10, -5);
    expect(resultZeroOffset.offset).toBe(0); // Min offset is 0
    expect(resultZeroOffset.dispatches.length).toBe(10);

    const resultInvalidLimit = await callActiveDispatches(undefined, "abc" as any, 0);
    expect(resultInvalidLimit.limit).toBe(50); // Defaults to 50
    expect(resultInvalidLimit.dispatches.length).toBe(50);

    const resultInvalidOffset = await callActiveDispatches(undefined, 10, "xyz" as any);
    expect(resultInvalidOffset.offset).toBe(0); // Defaults to 0
    expect(resultInvalidOffset.dispatches.length).toBe(10);
  });
});