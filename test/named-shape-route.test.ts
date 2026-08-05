// A goal that names a registered shape as the object of an action verb must reach THAT shape.
//
// The deterministic shortcuts in goal-target-inference return shellResult and return EARLY —
// before the LLM inferrer, and therefore before the advertised vocabulary is consulted at all.
// That is correct for confabulation-prone aggregates, but it also meant a purpose-built shape
// could be deployed, advertised, correct on direct call, and never once considered.
//
// Measured 2026-08-05: "Run the test suite for repos/goal-host-vessel and report how many tests
// passed and how many failed" inferred ["shellResult"] @0.6 with no alternatives (it matched the
// FILE-SYSTEM AGGREGATE shortcut on "how many" + "repos/…"), while `test_suite` — advertised by
// development-vessel and keyed to a landed sha — appeared ZERO times in 15 minutes of walk logs.
//
// The tests that matter here are the NEGATIVE ones. A rule that steals aggregate goals from the
// shellResult routes would regress the confabulation fixes those routes exist for, so the
// aggregate cases are pinned alongside the positive case.
import { describe, expect, it } from "bun:test";
import { inferGoalTargetDecision } from "../src/goal-target-inference.js";

const SHAPES = ["shellResult", "test_suite", "memoryNote_write", "substrateGap", "substrateGap_write", "llm_completion_dispatch"];

// `complete` THROWS. Every route asserted below is meant to resolve before the LLM inferrer is
// consulted, so a test that passes here is also proving the route is deterministic — if a
// shortcut stopped firing and the goal fell through to the model, `llmCalls` would be non-zero
// and the shape assertion would be reached by a different mechanism than the one under test.
let llmCalls = 0;
const infer = async (goal: string) => {
  llmCalls = 0;
  const d = await inferGoalTargetDecision(goal, SHAPES, {
    llmEndpoint: "http://127.0.0.1:65535",
    complete: async () => { llmCalls++; throw new Error("deterministic route must not consult the LLM"); },
  });
  return d;
};

describe("explicitly-named shape route", () => {
  it("routes 'run the test suite …' to test_suite, not the universal executor", async () => {
    const d = await infer("Run the test suite for repos/goal-host-vessel and report how many tests passed and how many failed.");
    expect(d.shapes).toEqual(["test_suite"]);
    expect(llmCalls).toBe(0);
  });

  // The fallback matters: a named shape that cannot produce must still degrade to the executor
  // rather than dead-ending the walk.
  it("offers shellResult as the alternative framing", async () => {
    const d = await infer("Run the test suite for repos/goal-host-vessel.");
    expect(d.alternatives).toEqual([["shellResult"]]);
  });

  it("matches the shape phrase however the goal spells it", async () => {
    for (const g of ["Execute the test-suite for repos/goal-host-vessel.", "Invoke the test_suite for repos/goal-host-vessel."]) {
      expect((await infer(g)).shapes).toEqual(["test_suite"]);
    }
  });

  it("never matches shellResult against itself", async () => {
    const d = await infer("Run the shell result for repos/goal-host-vessel.");
    expect(d.shapes).not.toEqual(["shell result"]);
  });
});

describe("NEGATIVE: the aggregate routes keep their shellResult path", () => {
  // "substrate gap" is a registered shape phrase, but counting gaps is fetch-then-transform.
  // Stealing this goal would regress the SUBSTRATE-DATA AGGREGATE route.
  it("an aggregate over a named shape still routes to shellResult", async () => {
    const d = await infer("Count the open substrate gaps by category and report the top 3.");
    expect(d.shapes).toEqual(["shellResult"]);
    expect(llmCalls).toBe(0);
  });

  it("a filesystem aggregate still routes to shellResult", async () => {
    const d = await infer("How many TypeScript files are under repos/development-vessel/src?");
    expect(d.shapes).toEqual(["shellResult"]);
    expect(llmCalls).toBe(0);
  });

  it("a registry inventory count still routes to shellResult", async () => {
    const d = await infer("How many vessels are currently registered in the discovery registry? Report the number.");
    expect(d.shapes).toEqual(["shellResult"]);
    expect(llmCalls).toBe(0);
  });

  // The action verb has to actually govern the shape phrase — a goal that merely mentions
  // running something must not be captured.
  it("does not fire when the action verb governs something else", async () => {
    const d = await infer("Count how many services are running in the container.");
    expect(d.shapes).toEqual(["shellResult"]);
    expect(llmCalls).toBe(0);
  });
});
