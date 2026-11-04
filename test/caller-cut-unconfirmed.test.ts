// A COMPOSE CUT AT THE CALLER IS UNCONFIRMED, NOT A DISCONFIRMATION.
//
// When the early edit-intent compose call is cut at the caller (a timeout or a closed socket) and the landed probe finds
// nothing, a check-supply goal returns cutCallerReason(...) with reached:false. Walk-complete then evicted the goal's
// cached command (struck, or tombstoned when nothing was in memory) and remembered a pick=feature_compose failure, though
// the compose runs on and may land minutes later. The cut names no infrastructure word, so the substring exemptions in
// evictReachedCommand never matched it. The cut is carried structurally (GoalSeekResult.callerCut) instead.
//
// The route itself runs inside runGoalWithRecoveryInner behind a compose ceiling and the /run-goal record path writes the
// dispatch store, so the wiring is pinned in the source (as check-supply-ledger-reason-wiring.test.ts does), and the two
// decision functions are driven directly. Evictions are driven only on paths that RETAIN: the cache file path is fixed
// at the module's first import, which in a whole-suite process may be another file's.
//
// Hermetic: fetch is stubbed to refuse for the whole file (restored after), and the failure memory is a temp file
// (index.ts reads GOAL_FAILURE_MEMORY_PATH at use). Import is dynamic, as in failed-trace-reason.test.ts.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ledger from "../src/check-supply-ledger-reason";
const { cutCallerReason, cutCallerOutcome } = ledger;

const TMP = mkdtempSync(join(tmpdir(), "caller-cut-unconfirmed-"));
process.env["GOAL_FAILURE_MEMORY_PATH"] = join(TMP, "failure-memory.jsonl");
process.env["REACHED_CMD_CACHE_PATH"] ||= join(TMP, "reached-commands.jsonl");
process.env["REACH_VERDICT_SPOOL_PATH"] ||= join(TMP, "reach-spool.jsonl");
process.env["MEM_DUMP_PATH"] ||= join(TMP, "mem-dump.json");
process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";

const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new TypeError("fetch refused (test: no network)"); }) as unknown as typeof fetch);
const m = await import("../src/index") as Record<string, any>;
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

afterAll(() => {
  fetchSpy.mockRestore();
  rmSync(TMP, { recursive: true, force: true });
});

/** The failure-memory records held for one goal text. The in-process memory is authoritative and written
 *  synchronously; the file append is fire-and-forget, so reading the file would race it. */
function remembered(goal: string): Array<{ reason: string; pick: string | null }> {
  return m.recallGoalFailures(goal).exact;
}
/** The reached-command cache log lines one evict call printed. */
function evictLog(hash: string, reason: string, unconfirmed?: boolean): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  try {
    if (unconfirmed === undefined) m.evictReachedCommand(hash, reason);
    else m.evictReachedCommand(hash, reason, unconfirmed);
  } finally { spy.mockRestore(); }
  return lines.filter((l) => l.includes("reached-command cache:"));
}

const CUT = cutCallerReason("fixture-gap-for-a-cut-compose", " stage=unknown (caller cut at 342s, no report)");
const JUDGED = "the judge found the summary lists five families where the goal asked for one";

describe("[MUST-FAIL] a caller-cut compose is retained and not remembered", () => {
  test("the no-walk return marks the cut structurally, only when the call was cut at the caller", () => {
    const stop = INDEX.indexOf("if (_earlyCheckSupplyNoWalk) {");
    expect(stop).toBeGreaterThan(0);
    const block = INDEX.slice(stop, stop + 2000);
    // the cut was timed at the caller; a narrower condition (no lesson of the compose's own) may join it
    expect(block).toMatch(/\.\.\.\(_earlyComposeCutAtCaller( && [!\w]+)? \? \{ callerCut: true \} : \{\}\),/);
  });

  test("walk-complete passes the cut into both decisions; the pinned calls stay the uncut branch", () => {
    expect(INDEX).toContain("if (seek.callerCut === true) evictReachedCommand(goalHashOf(record.goal), `reach graded false: ${String((seek.walkReachReason || record.goalReachReason) ?? \"no reason recorded\").slice(0, 120)}`, true);");
    expect(INDEX).toContain("if (seek.callerCut === true) rememberUnconfirmedDispatchFailures(record.goal, walkStepSink, record.goalReachReason, seek.selectedTemplateId, seek.completionShapes, seek.attempts);");
  });

  test("a cut dispatch's reasons are not remembered as a feature_compose failure", () => {
    const goal = "edit repos/fixture-vessel/src/a.ts to add the fixture symbol (cut at the caller)";
    expect(typeof m.rememberUnconfirmedDispatchFailures).toBe("function");
    const kept = m.rememberUnconfirmedDispatchFailures(goal, [], CUT, "feature_compose", ["fileEditResult"], 1);
    expect(kept).toEqual([]);
    expect(remembered(goal)).toEqual([]);
  });

  test("a cut reason retains the cached command: no strike, no tombstone", () => {
    expect(typeof m.evictReachedCommand).toBe("function");
    const lines = evictLog("fixture-hash-cut", `reach graded false: ${CUT.slice(0, 120)}`, true);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("RETAINED fixture-hash-cut (unconfirmed:");
    expect(lines.join("\n")).not.toMatch(/EVICTED|strike/);
  });

  test("a cut dispatch still remembers a reason that disconfirms", () => {
    const goal = "edit repos/fixture-vessel/src/b.ts to add the fixture symbol (cut, then a deterministic mismatch)";
    const det = "deterministic:early-edit-intent-hollow the requested symbol is absent";
    expect(typeof m.rememberUnconfirmedDispatchFailures).toBe("function");
    const kept = m.rememberUnconfirmedDispatchFailures(goal, [], det, "feature_compose", ["fileEditResult"], 1);
    expect(kept).toEqual([det]);
    expect(remembered(goal).map((r) => r.reason)).toEqual([det]);
  });
});

describe("CONTROL: a real disconfirmation still evicts and is remembered", () => {
  test("a judged false reach (no cut) is remembered with its pick", () => {
    const goal = "summarise the fixture families into one line (judged hollow)";
    const kept = m.rememberDispatchFailures(goal, [], JUDGED, "feature_compose", ["prose"], 1);
    expect(kept).toEqual([JUDGED]);
    const recs = remembered(goal);
    expect(recs.map((r) => r.reason)).toEqual([JUDGED]);
    expect(recs[0]!.pick).toBe("feature_compose");
  });

  test("the uncut walk-complete calls are unchanged, so a judged reason still reaches the strike counter and tombstone", () => {
    expect(INDEX).toContain("evictReachedCommand(goalHashOf(record.goal), `reach graded false: ${String((seek.walkReachReason || record.goalReachReason) ?? \"no reason recorded\").slice(0, 120)}`);");
    expect(INDEX).toContain("rememberDispatchFailures(record.goal, walkStepSink, record.goalReachReason, seek.selectedTemplateId, seek.completionShapes, seek.attempts);");
    const fn = INDEX.indexOf("function evictReachedCommand(");
    const body = INDEX.slice(fn, INDEX.indexOf("\n}\n", fn));
    expect(body).toContain("const strikes = (entry.strikes ?? 0) + 1;");
    expect(body).toContain("appendFile(REACHED_CMD_CACHE_PATH, JSON.stringify({ hash, tombstone: true, reason }) + \"\\n\")");
  });

  test("the deterministic markers still take eviction precedence", () => {
    const fn = INDEX.indexOf("function evictReachedCommand(");
    const body = INDEX.slice(fn, INDEX.indexOf("\n}\n", fn));
    // the markers sit inline in the evict body, or in the reachDisconfirmed predicate it calls
    const line = /const _disconfirmed = (.+);/.exec(body)?.[1] ?? "";
    let markers = line;
    if (line === "reachDisconfirmed(envOrUnknown)") {
      const p = INDEX.indexOf("function reachDisconfirmed(");
      expect(p).toBeGreaterThan(0);
      markers = INDEX.slice(p, INDEX.indexOf("\n}\n", p));
    }
    expect(markers).toContain('includes("deterministic:")');
    expect(markers).toContain('includes("recomputed")');
    expect(markers).toContain('includes("does not match")');
    expect(body).toContain("if (!_disconfirmed && _infra) {");
  });
});

describe("CONTROL: the infrastructure exemptions still retain", () => {
  test("the exemption list is intact", () => {
    expect(INDEX).toContain("const _infra = envOrUnknown.includes(\"capacity\") || envOrUnknown.includes(\"busy\") || envOrUnknown.includes(\"econnrefused\") || envOrUnknown.includes(\"connection\") || envOrUnknown.includes(\"unreachable\") || envOrUnknown.includes(\"timed out\") || envOrUnknown.includes(\"verdict unknown\") || envOrUnknown.includes(\"verdict=unknown\");");
  });

  test("an environment reason is not remembered", () => {
    for (const reason of ["feature_compose call failed: connect ECONNREFUSED", "the compose call timed out after 900 s"]) {
      const goal = `edit repos/fixture-vessel/src/c.ts to add the fixture symbol (${reason})`;
      expect(m.rememberDispatchFailures(goal, [], reason, "feature_compose", ["fileEditResult"], 1)).toEqual([reason]);
      expect(remembered(goal)).toEqual([]);
    }
  });
});

// NARROWED: a cut whose compose recorded its own failure lesson during the dispatch is a KNOWN failure, not unconfirmed.
// cutCallerOutcome found that lesson and the reason quoted its stage, yet callerCut was set on the cut alone, so the
// failure was retained and not remembered. callerCut now also requires that no lesson was recorded since dispatch start,
// decided by the same scan as a record (newestLessonSince), never by reading the outcome text.
const START = 1_900_000_000_000; // a fixed instant, as epoch ms
const iso = (ms: number): string => new Date(ms).toISOString();
const rowWith = (lessons: unknown[]) => ({ id: "fixture-gap-narrow", classification_metadata: { failure_lessons: lessons } });
const KNOWN = rowWith([{ at: iso(START + 60_000), stage: "test_writing", class: "verify_failed", reason: "the written check did not fail at the parent" }]);
const AT_START = rowWith([{ at: iso(START), stage: "test_writing", reason: "fixture lesson at the start instant" }]);
const OLDER = rowWith([{ at: iso(START - 60_000), stage: "semantic_gate", reason: "an earlier attempt's lesson" }]);

describe("[MUST-FAIL] a timed cut whose compose recorded a lesson is graded, not unconfirmed", () => {
  test("the no-walk return sets callerCut only when no lesson was recorded since the dispatch started", () => {
    const stop = INDEX.indexOf("if (_earlyCheckSupplyNoWalk) {");
    const block = INDEX.slice(stop, stop + 2500);
    expect(block).toContain("const _cutLessonKnown = newestLessonSince(_cutRow, _dispatchStartMs) !== null;");
    expect(block).toContain("...(_earlyComposeCutAtCaller && !_cutLessonKnown ? { callerCut: true } : {}),");
    // one gap-row read serves both the outcome and the lesson check
    expect(block.split("readGapByIdForOracle(").length - 1).toBe(1);
  });

  test("a lesson at or after the dispatch start is found as a record", () => {
    expect(typeof (ledger as Record<string, unknown>)["newestLessonSince"]).toBe("function");
    const find = (ledger as Record<string, any>)["newestLessonSince"];
    expect(find(KNOWN, START)?.stage).toBe("test_writing");
    expect(find(AT_START, START)?.stage).toBe("test_writing");
  });

  test("the record and the outcome text come from the same scan", () => {
    expect(typeof (ledger as Record<string, unknown>)["newestLessonSince"]).toBe("function");
    const find = (ledger as Record<string, any>)["newestLessonSince"];
    for (const row of [null, rowWith([]), OLDER, KNOWN, AT_START, rowWith([{ at: "not a time", stage: "x" }])]) {
      const noReport = cutCallerOutcome(row, START, 342) === " stage=unknown (caller cut at 342s, no report)";
      expect(find(row, START) === null).toBe(noReport);
    }
  });
});

describe("a known cut failure takes the uncut path; an unknown one stays unconfirmed", () => {
  test("the known failure's reason names its stage and is remembered on the uncut path", () => {
    const reason = cutCallerReason("fixture-gap-narrow", cutCallerOutcome(KNOWN, START, 342));
    expect(reason).toContain("stage=test_writing");
    const goal = "edit repos/fixture-vessel/src/d.ts to add the fixture symbol (cut, lesson recorded)";
    expect(m.rememberDispatchFailures(goal, [], reason, "feature_compose", ["fileEditResult"], 1)).toEqual([reason]);
    expect(remembered(goal).map((r) => r.reason)).toEqual([reason]);
  });

  test("with no lesson since start (none, or only older), the cut is retained and not remembered", () => {
    for (const [i, row] of [null, OLDER].entries()) {
      const reason = cutCallerReason("fixture-gap-narrow", cutCallerOutcome(row, START, 342));
      expect(reason).toContain("stage=unknown (caller cut at 342s, no report)");
      const goal = `edit repos/fixture-vessel/src/e${i}.ts to add the fixture symbol (cut, no lesson)`;
      expect(m.rememberUnconfirmedDispatchFailures(goal, [], reason, "feature_compose", ["fileEditResult"], 1)).toEqual([]);
      expect(remembered(goal)).toEqual([]);
      const lines = evictLog(`fixture-hash-narrow-${i}`, `reach graded false: ${reason.slice(0, 120)}`, true);
      expect(lines.join("\n")).toContain("(unconfirmed:");
      expect(lines.join("\n")).not.toMatch(/EVICTED|strike/);
    }
  });

  test("a deterministic marker still disconfirms an unconfirmed dispatch", () => {
    const det = "deterministic:early-edit-intent-hollow the requested symbol is absent (narrow fixture)";
    const goal = "edit repos/fixture-vessel/src/f.ts to add the fixture symbol (cut, deterministic)";
    expect(m.rememberUnconfirmedDispatchFailures(goal, [], det, "feature_compose", ["fileEditResult"], 1)).toEqual([det]);
    expect(m.reachDisconfirmed(det)).toBe(true);
  });
});
