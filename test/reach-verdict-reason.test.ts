// The late reach verdict carries its REASON and the goal hash (slice Y1d).
//
// WHY. The deterministic not-reached verdicts (e.g. `deterministic:edit-intent-no-landed-edit`)
// are decided after the trace is inserted and reach the store only through POST /reach, whose
// body was {execution_id, reached, completion_shapes}. Measured: 0 execution rows carry that
// verdict while the local failure memory holds 450 records over 288 goals — the reason never
// left this process, so no detector could count the class. activity-api /reach (Y1c) now
// classifies a not-reached verdict that arrives with a reason; this is the sending half.
//
// Import is dynamic for the reason given in index-pure-exports.test.ts (module bootstrap needs
// LLM_VESSEL_ENDPOINT). fetch is spied and restored, never mocked process-wide.
import { describe, expect, test, spyOn } from "bun:test";

process.env["LLM_VESSEL_ENDPOINT"] ||= "http://127.0.0.1:8220";
const { reachVerdictBody, deliverReachVerdict } = await import("../src/index");

const REASON = "deterministic:edit-intent-no-landed-edit — an edit goal is reached only by an edit-result shape WITH landing evidence";

describe("reachVerdictBody — the POST /reach body", () => {
  test("a not-reached verdict carries its reason and the goal hash", () => {
    const b = JSON.parse(reachVerdictBody("exec_1", false, ["fileEditResult"], REASON, "a1b2c3"));
    expect(b).toEqual({ execution_id: "exec_1", reached: false, completion_shapes: ["fileEditResult"], reason: REASON, goal_hash: "a1b2c3" });
  });

  test("no class is sent: classification happens once, at the store", () => {
    const b = JSON.parse(reachVerdictBody("exec_1", false, [], REASON, "h"));
    expect(Object.keys(b).some((k) => /class/i.test(k))).toBe(false);
  });

  test("the reason is capped at 600 chars", () => {
    const b = JSON.parse(reachVerdictBody("exec_1", false, [], REASON + " " + "x".repeat(5000), "h"));
    expect(b.reason.length).toBe(600);
    expect(b.reason.startsWith("deterministic:edit-intent-no-landed-edit")).toBe(true);
  });

  test("MUST-FAIL: an absent or empty reason / hash is omitted, never sent as an empty string", () => {
    for (const [r, h] of [[undefined, undefined], [null, null], ["", "  "], ["   ", ""]] as const) {
      const b = JSON.parse(reachVerdictBody("exec_1", false, null, r, h));
      expect(b).toEqual({ execution_id: "exec_1", reached: false, completion_shapes: [] });
    }
  });
});

describe("deliverReachVerdict — sends the reason on the wire", () => {
  async function captured(run: () => void): Promise<Array<Record<string, unknown>>> {
    const bodies: Array<Record<string, unknown>> = [];
    // A definitive 4xx: not retried, not spooled, no spool drain — the body is all we need.
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/execution-traces/reach")) bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 400 });
    }) as typeof fetch);
    try {
      run();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      spy.mockRestore();
    }
    return bodies;
  }

  test("a not-reached verdict posts the reason and goal_hash", async () => {
    const bodies = await captured(() => deliverReachVerdict("exec_y1d", false, [], "walk-complete", REASON, "gh-1"));
    expect(bodies).toEqual([{ execution_id: "exec_y1d", reached: false, completion_shapes: [], reason: REASON, goal_hash: "gh-1" }]);
  });

  test("an old caller (no reason) still posts the legacy body", async () => {
    const bodies = await captured(() => deliverReachVerdict("exec_y1d_legacy", true, ["x"], "walk-complete"));
    expect(bodies).toEqual([{ execution_id: "exec_y1d_legacy", reached: true, completion_shapes: ["x"] }]);
  });

  test("MUST-FAIL: a synthetic id still posts nothing, reason or not", async () => {
    const bodies = await captured(() => deliverReachVerdict("feature_compose:busy", false, [], "walk-threw", REASON, "gh-1"));
    expect(bodies).toEqual([]);
  });
});

describe("every delivery site passes a reason and the goal hash", () => {
  // The three call sites live inside the dispatch path, which no unit test can drive; a site
  // that drops the arguments silently restores the reason-less body for its whole class.
  test("walk-complete, walk-threw and the early edit-intent site", async () => {
    const s = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const calls = [...s.matchAll(/deliverReachVerdict\(([^;]*)\);/g)].map((m) => m[1]!).filter((a) => !a.includes("executionId: string"));
    expect(calls.length).toBe(3);
    const byOrigin = Object.fromEntries(calls.map((a) => [(a.match(/"(walk-complete|walk-threw|early-edit-intent-unfavorable)"/) ?? [])[1], a]));
    expect(byOrigin["walk-complete"]).toContain("seek.goalReachReason");
    expect(byOrigin["walk-threw"]).toContain("record.error");
    expect(byOrigin["early-edit-intent-unfavorable"]).toContain('"deterministic:early-edit-intent-not-landed"');
    for (const a of calls) expect(a).toContain("goalHashOf(");
  });
});
