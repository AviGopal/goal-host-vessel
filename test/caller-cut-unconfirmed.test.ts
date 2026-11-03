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
import { cutCallerReason } from "../src/check-supply-ledger-reason";

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
    expect(block).toContain("...(_earlyComposeCutAtCaller ? { callerCut: true } : {}),");
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
