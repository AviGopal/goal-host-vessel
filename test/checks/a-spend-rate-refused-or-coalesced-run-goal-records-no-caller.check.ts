import { describe, test, expect } from "bun:test";
import * as mod from "../../src/index";

function req(body: Record<string, unknown>): Request {
  return new Request("http://localhost/run-goal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// This check reproduces the coalesce path: two identical goals sent concurrently.
// The second responder (a coalesced duplicate) should attribute the caller,
// but the current implementation returns a 202 that carries no caller — the
// assertion below names the expected, correct value.

describe("spend-rate breaker and coalesce interaction", () => {
  test("coalesced duplicate 202 response should include caller 'later-caller' (expected), but defect omits it", async () => {
    const goal = `unit-test: coalesce-attribution ${Date.now()}`;

    const p1 = mod.handleRunGoal(req({ goal, caller: "first-caller", operator: "unit-op", trigger: "unit-trigger", tags: ["unit", "test"] }));
    const p2 = mod.handleRunGoal(req({ goal, caller: "later-caller", operator: "unit-op", trigger: "unit-trigger", tags: ["unit", "test"] }));

    const [r1, r2] = await Promise.all([p1, p2]);

    // We exercise the coalesce branch: both should be Accepted while one run is in-flight.
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);

    // The coalesced response should attribute the caller that re-sent the same goal.
    let body2: unknown;
    try {
      body2 = await r2.json();
    } catch {
      body2 = {};
    }
    const obj2 = (typeof body2 === "object" && body2 !== null ? (body2 as Record<string, unknown>) : {});

    // Fails today: the coalesce 202 carries the running dispatch id but no caller attribution.
    expect(obj2["caller"]).toBe("later-caller");
  });

  // CONTROL: a unique goal should still be admitted (202 Accepted). This is unaffected by the defect.
  test("control: unique run yields 202 Accepted", async () => {
    const uniqueGoal = `unit-test: unique-run ${Date.now()} ${Math.random()}`;
    const res = await mod.handleRunGoal(req({ goal: uniqueGoal, caller: "control-caller" }));
    expect(res.status).toBe(202);
  });
});
