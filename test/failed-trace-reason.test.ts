// A FAILURE KEEPS ITS REASON ON THE WAY TO THE TRACE (B2).
//
// A failed trace says why it failed (failureMode.reason, or the failing task's error), and a thrown dispatch says
// why in its message. Neither reached goalReachReason: every assignment sat on the completed/reach-gate path, and the
// async /run-goal catch set only `error`. So the failure memory stored nothing for those dispatches and the recovery
// loop's next attempt classified a reasonless failure.
//
//
// Hermetic: fetch is stubbed to refuse for the whole file (restored after), and the failure memory file is a temp path
// (index.ts reads GOAL_FAILURE_MEMORY_PATH at use, so this holds even when another file imported the module first).
// Import is dynamic for the reason given in index-pure-exports.test.ts.
import { afterAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "failed-trace-reason-"));
process.env["GOAL_FAILURE_MEMORY_PATH"] = join(TMP, "failure-memory.jsonl");
process.env["REACHED_CMD_CACHE_PATH"] ||= join(TMP, "reached-commands.jsonl");
process.env["REACH_VERDICT_SPOOL_PATH"] ||= join(TMP, "reach-spool.jsonl");
process.env["MEM_DUMP_PATH"] ||= join(TMP, "mem-dump.json");
process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";

// No network from this file, the module's import-time work included.
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new TypeError("fetch refused (test: no network)"); }) as unknown as typeof fetch);
const m = await import("../src/index");
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

afterAll(() => {
  fetchSpy.mockRestore();
  rmSync(TMP, { recursive: true, force: true });
});

describe("the record path and the throw path both use the shared builder", () => {
  test("the async /run-goal success path remembers through rememberDispatchFailures with the record's reason", () => {
    const i = INDEX.indexOf("if (seek.goalReachReason) record.goalReachReason = seek.goalReachReason;");
    const j = INDEX.indexOf("rememberDispatchFailures(record.goal, walkStepSink, record.goalReachReason, seek.selectedTemplateId, seek.completionShapes, seek.attempts);");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });

  test("the async /run-goal catch records the thrown reason and remembers it (not for a pinned refusal)", () => {
    const c = INDEX.indexOf("const __isPinnedRefusal = /^refusing pinned target/i");
    const set = INDEX.indexOf("record.goalReachReason = thrownDispatchReason(err);", c);
    const rem = INDEX.indexOf("if (!__isPinnedRefusal && typeof record.goal === \"string\" && record.goal) {\n        rememberDispatchFailures(record.goal, walkStepSink, record.goalReachReason,", c);
    expect(c).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(c);
    expect(rem).toBeGreaterThan(set);
  });

  test("the builder keeps attempt order, dedups, caps at three and reads both verdict markers", () => {
    const log = ["walk: HOLLOW — five families instead of one; β-penalised", "x attempt 1/2 via t: TRACE FAILED — parse(csv): bad row", "walk: HOLLOW — five families instead of one"];
    expect(m.dispatchFailureReasons(log, "terminal reason")).toEqual(["five families instead of one", "parse(csv): bad row", "terminal reason"]);
    expect(m.dispatchFailureReasons(log, "parse(csv): bad row")).toEqual(["five families instead of one", "parse(csv): bad row"]);
  });
});

describe("an early compose refusal with no error still carries a reason", () => {
  test("failure_kind, verify and semantic_gate form the reason when error is absent", () => {
    const r = m.composeReportReason({ verdict: "UNFAVORABLE", failure_kind: "fix", verify: [{ vessel: "goal-host-vessel", ok: false, output: "src/a.ts(3,1): error TS2304: Cannot find name 'x'.\nok line" }], semantic_gate: { reason: "the diff does not add the requested guard" } });
    expect(r).toContain("failure_kind=fix");
    expect(r).toContain("verify failed (goal-host-vessel): src/a.ts(3,1): error TS2304");
    expect(r).toContain("semantic_gate: the diff does not add the requested guard");
  });

  test("an error, when present, is the reason exactly as before", () => {
    expect(m.composeReportReason({ error: "admission: goal names no repos file", failure_kind: "terminal_refusal" })).toBe("admission: goal names no repos file");
    expect(m.composeReportReason({})).toBe("no failure detail in compose report");
  });
});
