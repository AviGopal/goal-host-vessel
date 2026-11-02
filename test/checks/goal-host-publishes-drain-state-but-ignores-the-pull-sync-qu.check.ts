import { describe, test, expect } from "bun:test";
import * as mod from "../../src/index";
import { mkdir, writeFile, rm } from "fs/promises";

const QUIESCE_DIR = "/workspace/quiesce";
const VESSEL_MARKER = `${QUIESCE_DIR}/goal-host-vessel`;

async function setQuiesceMarker(present: boolean): Promise<void> {
  if (present) {
    await mkdir(QUIESCE_DIR, { recursive: true });
    // Fresh marker (mtime-based checks in other systems use freshness)
    await writeFile(VESSEL_MARKER, String(Date.now()), { encoding: "utf8" });
  } else {
    await rm(VESSEL_MARKER, { force: true });
  }
}

function runGoalRequest(body: unknown): Request {
  return new Request("http://local/run-goal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("goal-host quiesce gate and health drain advertisement", () => {
  test("FAILS NOW: with /workspace/quiesce/goal-host-vessel present, new runs are refused as retryable quiesced (503), removing marker restores admission", async () => {
    // Arrange: hold the quiesce marker
    await setQuiesceMarker(true);

    // Act: attempt to start a new goal run directly through the exported handler
    // We intentionally send a minimal body; under quiesce a correct host rejects BEFORE validation.
    const req1 = mod.markInboundRemote(runGoalRequest({ goal: "noop" }), null as unknown as string | null);
    const res1 = await mod.handleRunGoal(req1);

    // Assert: during quiesce the admission is refused with a retryable service-level refusal (expected 503)
    // Defect: current code ignores the marker and accepts/validates instead, so this assertion FAILS now.
    expect(res1.status).toBe(503);

    // Remove the marker: admission should be restored (not the quiesced 503). We don't assert specific success code
    // because validation may still refuse (400), but it must NOT be the quiesce gate (503).
    await setQuiesceMarker(false);
    const req2 = mod.markInboundRemote(runGoalRequest({ goal: "noop" }), null as unknown as string | null);
    const res2 = await mod.handleRunGoal(req2);
    expect(res2.status).not.toBe(503);
  });

  test("CONTROL: /health advertises drain_ms from env (anchor at health's Response.json)", async () => {
    // Ensure not quiescing for this control path
    await setQuiesceMarker(false);

    // Pick a distinct value to verify the health payload reflects the current env at request time
    const prior = process.env["GOAL_HOST_DRAIN_MS"]; 
    process.env["GOAL_HOST_DRAIN_MS"] = "91234";

    try {
      // Importing the module spins the server; call its health endpoint directly.
      const res = await fetch("http://127.0.0.1:8210/health");
      expect(res.ok).toBe(true);
      const body = (await res.json()) as Record<string, unknown>;
      const dm = Number(body["drain_ms"]);
      expect(Number.isFinite(dm)).toBe(true);
      expect(dm).toBe(91234);
    } finally {
      if (prior === undefined) delete process.env["GOAL_HOST_DRAIN_MS"]; else process.env["GOAL_HOST_DRAIN_MS"] = prior;
    }
  });
});
