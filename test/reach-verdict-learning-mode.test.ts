// AN OBSERVE DISPATCH'S REACH VERDICT SAYS SO, AND ITS DRY-RUN EDIT ROUTE ABSTAINS (observe-mode.ts).
//
// Measured: an observe probe's verdict reached activity-api POST /reach exactly like a learn dispatch's, and /reach
// graded it into the arm's posteriors on arrival. The verdict now carries the dispatch's learning_mode (read from the
// dispatch context at delivery), so /reach records it without grading. And an observe edit-intent dispatch, whose
// compose ran as a dry run, ends as an ABSTAIN (reached:null on the record, no reach verdict delivered, no failure
// remembered) with the named reason, never as failed/false.
//   [MUST-FAIL] reachVerdictBody(..., "observe") carries learning_mode:"observe"; deliverReachVerdict passes the
//               dispatch's mode; the three observe edit-intent returns are observeComposeOutcome (an abstain).
//   [CONTROL]   with no mode the body is byte-for-byte today's; a delivery outside any dispatch carries no mode; the
//               /run-goal record maps an abstain to reached:null and delivers no verdict for it.
import { describe, expect, test, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observeComposeOutcome } from "../src/observe-mode";

process.env["LLM_VESSEL_ENDPOINT"] ||= "http://127.0.0.1:8220";
const { reachVerdictBody, deliverReachVerdict } = await import("../src/index");
const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
const today = JSON.stringify({ execution_id: "exec_1", reached: true, completion_shapes: ["shellResult"], reason: "ok", goal_hash: "h1" });

describe("the reach verdict carries the dispatch's learning mode", () => {
  test("[MUST-FAIL] an observe body says learning_mode observe", () => {
    const b = JSON.parse(reachVerdictBody("exec_1", true, ["shellResult"], "ok", "h1", undefined, "observe"));
    expect(b.learning_mode).toBe("observe");
    expect(b.reached).toBe(true);
  });
  test("[CONTROL] no mode: the body is today's, byte for byte", () => {
    expect(reachVerdictBody("exec_1", true, ["shellResult"], "ok", "h1")).toBe(today);
    expect(reachVerdictBody("exec_1", true, ["shellResult"], "ok", "h1", undefined, null)).toBe(today);
  });
  test("[MUST-FAIL] deliverReachVerdict passes the mode of the dispatch it runs for", () => {
    expect(SRC).toContain("reachVerdictBody(executionId as string, reached as boolean, completionShapes, reason, goalHash, betaWithheld?.get(executionId as string), dispatchLearningMode(), dispatchRecalledConceptIds());");
    expect(SRC).toContain("return dispatchContext.getStore()?.learningMode;");
  });
  test("[CONTROL] a delivery outside any dispatch carries no mode", async () => {
    const bodies: string[] = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/execution-traces/reach")) bodies.push(String(init?.body));
      return new Response("{}", { status: 400 });
    }) as typeof fetch);
    try { deliverReachVerdict("exec_2", true, ["shellResult"], "test", "ok", "h1", null); await new Promise((r) => setTimeout(r, 50)); } finally { spy.mockRestore(); }
    expect(bodies.length).toBe(1);
    expect(JSON.parse(bodies[0]!).learning_mode).toBeUndefined();
  });
});

describe("an observe edit-intent dispatch abstains", () => {
  test("[MUST-FAIL] the outcome is an abstain with the named reason", () => {
    const o = observeComposeOutcome("FAVORABLE", "ops=2");
    expect(o.abstain).toEqual({ kind: "observe-dry-run", cuts: [] });
    expect(o.goalReachReason).toBe("observe: dry run, not landed — feature_compose verdict=FAVORABLE; ops=2");
  });
  test("[MUST-FAIL] all three observe returns of the edit-intent route are that abstain", () => {
    expect(SRC.match(/\.\.\.observeComposeOutcome\(/g)?.length).toBe(3);
    expect(SRC).not.toContain("goalReachReason: observeComposeReason(");
    expect(SRC).toContain('type GateAbstain = { kind: "cut-view" | "oracle-abstain" | "observe-dry-run"; cuts: JudgeCut[]; family?: string };');
  });
  test("[CONTROL] /run-goal records an abstain as reached:null, so no verdict is delivered and no failure remembered", () => {
    const i = SRC.indexOf("if (seek.abstain) {\n        record.reached = null;");
    expect(i).toBeGreaterThan(0);
    expect(SRC.indexOf('if (record.reached === false) {', i)).toBeGreaterThan(i);
  });
});
