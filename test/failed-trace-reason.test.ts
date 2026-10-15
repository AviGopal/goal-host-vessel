// A FAILURE KEEPS ITS REASON ON THE WAY TO THE TRACE (B2).
//
// A failed trace says why it failed (failureMode.reason, or the failing task's error), and a thrown dispatch says
// why in its message. Neither reached goalReachReason: every assignment sat on the completed/reach-gate path, and the
// async /run-goal catch set only `error`. So the failure memory stored nothing for those dispatches and the recovery
// loop's next attempt classified a reasonless failure.
//
// runGoalWithRecovery is DRIVEN here: a pinned first target with maxAttempts 1 skips the walk and the retry branch,
// and GoalHost.prototype.runGoal is spied to return the fixture trace (or throw). The /run-goal record path cannot be
// driven without writing the dispatch store under /workspace, so its two uses of the shared builder are pinned in the
// source, and the builder itself is driven into the failure memory and recalled.
//
// Hermetic: fetch is stubbed to refuse for the whole file (restored after), and the failure memory file is a temp path
// (index.ts reads GOAL_FAILURE_MEMORY_PATH at use, so this holds even when another file imported the module first).
// Import is dynamic for the reason given in index-pure-exports.test.ts.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
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
const { GoalHost } = await import("@avigopal/ias-executor-ts");
const m = await import("../src/index");
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

afterAll(() => {
  fetchSpy.mockRestore();
  rmSync(TMP, { recursive: true, force: true });
});

type Trace = { id: string; status: string; failureMode?: { type: string; reason: string }; tasks: Array<Record<string, unknown>> };
async function runPinned(goal: string, trace: Trace | Error) {
  const spy = spyOn(GoalHost.prototype as unknown as { runGoal: (...a: unknown[]) => Promise<unknown> }, "runGoal").mockImplementation(async () => {
    if (trace instanceof Error) throw trace;
    return { selectedTemplateId: "tpl-fixture", trace };
  });
  const stepSink: string[] = [];
  try {
    const r = await m.runGoalWithRecovery(goal, { firstTarget: "tpl-fixture", callerPinned: true, maxAttempts: 1, variables: {}, surface: "test", stepSink, learningMode: "observe" } as never);
    return { r, stepSink };
  } finally {
    spy.mockRestore();
  }
}

const FM_REASON = "Resolver 'csv_parse' rejected the input: column 'qty' is not numeric";

describe("a failed trace's reason reaches the result, the record and the failure memory", () => {
  test("[MUST-FAIL] failureMode.reason becomes goalReachReason, and the dispatch builder remembers it", async () => {
    const goal = "summarise the fixture inventory sheet by quantity (failure-mode case)";
    const { r, stepSink } = await runPinned(goal, { id: "exec-fm", status: "failed", failureMode: { type: "execution_error", reason: FM_REASON }, tasks: [{ taskId: "t1", resolverId: "csv_parse", success: false, error: "other text" }] });
    expect(r.status).toBe("failed");
    expect(r.reached).toBe(false);
    expect(r.goalReachReason).toBe(FM_REASON);
    // The attempt's verdict line lands in the walk log the record keeps.
    expect(stepSink.some((l) => l.includes(`TRACE FAILED — ${FM_REASON}`))).toBe(true);
    // The record path hands the walk log and the result's reason to the builder; driven here as the record does.
    const remembered = m.rememberDispatchFailures(goal, stepSink, r.goalReachReason, r.selectedTemplateId, r.completionShapes, r.attempts);
    expect(remembered).toEqual([FM_REASON]);
    const recalled = m.recallGoalFailures(goal).exact.map((x) => x.reason);
    expect(recalled).toContain(FM_REASON);
    // The append is fire-and-forget (fail-open); wait for it rather than racing it.
    let onDisk = "";
    for (let i = 0; i < 50 && !onDisk.includes(FM_REASON); i++) {
      await new Promise((r) => setTimeout(r, 20));
      try { onDisk = readFileSync(process.env["GOAL_FAILURE_MEMORY_PATH"]!, "utf-8"); } catch { /* not written yet */ }
    }
    expect(onDisk).toContain(FM_REASON);
  });

  test("without failureMode, the first failed task's \"<taskId>(<resolver>): <error>\" is the reason", async () => {
    const goal = "summarise the fixture inventory sheet by quantity (task-error case)";
    const { r } = await runPinned(goal, { id: "exec-task", status: "failed", tasks: [
      { taskId: "load", resolverId: "fs_read", success: true },
      { taskId: "parse", resolverId: "csv_parse", success: false, error: "row 7 has 3 fields, expected 4" },
      { taskId: "sum", resolverId: "aggregate", success: false, error: "no input" },
    ] });
    expect(r.goalReachReason).toBe("parse(csv_parse): row 7 has 3 fields, expected 4");
    expect(m.failedTraceReason({ status: "failed", tasks: [{ taskId: "a", resolverId: "r", success: false }] })).toBe("a(r): no error recorded");
    expect(m.failedTraceReason({ status: "failed", tasks: [{ taskId: "a", success: true }] })).toBeUndefined();
  });

  test("a thrown runGoal: the reason is the error message, and it is remembered", async () => {
    const goal = "summarise the fixture inventory sheet by quantity (thrown case)";
    const err = new Error("template 'tpl-fixture' declares input 'sheet' that no impulse supplies");
    await expect(runPinned(goal, err)).rejects.toThrow(err.message);
    // The /run-goal catch derives the record's reason with this helper and remembers it through the builder.
    const reason = m.thrownDispatchReason(err);
    expect(reason).toBe(err.message);
    expect(m.rememberDispatchFailures(goal, [], reason, undefined, null, undefined)).toEqual([err.message]);
    expect(m.recallGoalFailures(goal).exact.map((x) => x.reason)).toContain(err.message);
    expect(m.thrownDispatchReason("plain string throw")).toBe("plain string throw");
  });

  test("a completed trace takes the reach-gate path unchanged: no TRACE FAILED line, no failure-side reason", async () => {
    const goal = "summarise the fixture inventory sheet by quantity (completed case)";
    const { r, stepSink } = await runPinned(goal, { id: "exec-ok", status: "completed", failureMode: { type: "execution_error", reason: "must not be read on a completed trace" }, tasks: [{ taskId: "t1", resolverId: "csv_parse", success: true, outputShapes: ["inventorySummary"] }] });
    expect(stepSink.some((l) => l.includes("TRACE FAILED"))).toBe(false);
    expect(String(r.goalReachReason ?? "")).not.toContain("must not be read");
  });
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

  test("both early refusal sites use it in place of the bare error", () => {
    expect(INDEX).toContain("refused at admission (stage=${_earlyAdmissionStage}): ${composeReportReason(earlyBody)}");
    expect(INDEX).toContain("check_supply compose refused at ${_stage} (verdict=${earlyVerdict || \"(none)\"}): ${composeReportReason(earlyBody)}");
  });
});
