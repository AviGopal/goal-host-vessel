// AN ADMISSION REFUSAL IS A NON-ATTEMPT, NOT A FAILURE.
//
// feature_compose refuses some composes at ADMISSION, before any slot or draft (compose-admission-refusal.ts: the gap is
// not compose work, is held, or its check-supply ledger cannot be verified). The compose never ran, yet walk-complete
// graded the refusal like a content failure: it evicted the goal's cached command (a strike, or a tombstone) and
// remembered a pick=feature_compose lesson. Both admission returns now carry the existing CHANGE-30 outcome
// { kind: "refused", refuse_class: "admission_<stage>" }, and walk-complete reads an explicit allowlist of non-attempt
// outcomes (compose-admission-refusal.ts isNonAttemptOutcome): retained, and only a disconfirming reason is remembered.
// A judged refusal (secret_extraction, a semantic-gate UNFAVORABLE) is graded as before.
//
// The routes run inside runGoalWithRecoveryInner and walk-complete inside the /run-goal record path, so the wiring is
// pinned in the source and the decision functions are driven directly (as caller-cut-unconfirmed.test.ts does).
// Evictions are driven only on paths that RETAIN: the cache file path is fixed at the module's first import.
// Hermetic: fetch is stubbed for the whole file, and the failure memory is a temp file read at use.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as admission from "../src/compose-admission-refusal";

const TMP = mkdtempSync(join(tmpdir(), "admission-refusal-non-attempt-"));
process.env["GOAL_FAILURE_MEMORY_PATH"] = join(TMP, "failure-memory.jsonl");
process.env["REACHED_CMD_CACHE_PATH"] ||= join(TMP, "reached-commands.jsonl");
process.env["REACH_VERDICT_SPOOL_PATH"] ||= join(TMP, "reach-spool.jsonl");
process.env["MEM_DUMP_PATH"] ||= join(TMP, "mem-dump.json");
process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";

const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new TypeError("fetch refused (test: no network)"); }) as unknown as typeof fetch);
const m = await import("../src/index") as Record<string, any>;
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
const isNonAttempt = (admission as Record<string, any>)["isNonAttemptOutcome"];

afterAll(() => {
  fetchSpy.mockRestore();
  rmSync(TMP, { recursive: true, force: true });
});

const remembered = (goal: string): Array<{ reason: string; pick: string | null }> => m.recallGoalFailures(goal).exact;
function evictLog(hash: string, reason: string, unconfirmed?: boolean | string): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  try {
    if (unconfirmed === undefined) m.evictReachedCommand(hash, reason);
    else m.evictReachedCommand(hash, reason, unconfirmed);
  } finally { spy.mockRestore(); }
  return lines.filter((l) => l.includes("reached-command cache:"));
}
const ADMISSION_REASON = "early edit-intent routed to feature_compose; refused at admission (stage=ineligible): the fixture gap is not armed - an admission refusal is final, so it is neither walked nor escalated";
const JUDGED = "the judge found the fixture summary lists five families where the goal asked for one";

describe("[MUST-FAIL] an admission-refused dispatch is retained and not remembered", () => {
  test("both admission returns carry the CHANGE-30 refused outcome with the stage as its class", () => {
    const early = INDEX.indexOf("const _earlyAdmissionStage = composeAdmissionRefusal(earlyBody);");
    expect(early).toBeGreaterThan(0);
    expect(INDEX.slice(early, early + 1200)).toContain('outcome: { kind: "refused", refuse_class: `${ADMISSION_REFUSE_CLASS_PREFIX}${_earlyAdmissionStage}` },');
    const post = INDEX.indexOf("const _admissionStage = composeAdmissionRefusal(body);");
    expect(post).toBeGreaterThan(0);
    expect(INDEX.slice(post, post + 1200)).toContain('outcome: { kind: "refused", refuse_class: `${ADMISSION_REFUSE_CLASS_PREFIX}${_admissionStage}` },');
  });

  test("walk-complete reads the outcome for both decisions, after the caller-cut branch and before the pinned calls", () => {
    const evict = INDEX.indexOf("else if (isNonAttemptOutcome(seek.outcome)) evictReachedCommand(");
    const remember = INDEX.indexOf("else if (isNonAttemptOutcome(seek.outcome)) rememberUnconfirmedDispatchFailures(");
    expect(evict).toBeGreaterThan(INDEX.indexOf("if (seek.callerCut === true) evictReachedCommand("));
    expect(remember).toBeGreaterThan(INDEX.indexOf("if (seek.callerCut === true) rememberUnconfirmedDispatchFailures("));
    expect(INDEX.indexOf("else evictReachedCommand(goalHashOf(record.goal), `reach graded false: ", evict)).toBeGreaterThan(evict);
  });

  test("the non-attempt allowlist is explicit: admission_<stage>, spend_rate and non_attempt, and nothing else", () => {
    expect(typeof isNonAttempt).toBe("function");
    for (const stage of admission.ADMISSION_REFUSAL_STAGES) expect(isNonAttempt({ kind: "refused", refuse_class: `admission_${stage}` })).toBe(true);
    expect(isNonAttempt({ kind: "refused", refuse_class: "spend_rate", retry_after_s: 60 })).toBe(true);
    expect(isNonAttempt({ kind: "non_attempt", failure_kind: "capacity" })).toBe(true);
    expect(isNonAttempt({ kind: "non_attempt", failure_kind: "environment", refuse_class: "gap_store_unavailable" })).toBe(true);
    // judged or unknown classes are graded as before
    for (const c of ["secret_extraction", "semantic_gate", "ineligible", "admission_scope", "admission_", "fixture_unknown_class"]) expect(isNonAttempt({ kind: "refused", refuse_class: c })).toBe(false);
    expect(isNonAttempt({ kind: "refused" })).toBe(false);
    expect(isNonAttempt({ kind: "needs_information", reason: "unbound_input", missing: [] })).toBe(false);
    expect(isNonAttempt(undefined)).toBe(false);
  });

  test("the refusal's reason is retained by the cache and not remembered, with logs naming the non-attempt", () => {
    expect(typeof isNonAttempt).toBe("function");
    const why = "a non-attempt (refused/admission_ineligible), nothing was produced to judge";
    const lines = evictLog("fixture-hash-admission", `reach graded false: ${ADMISSION_REASON.slice(0, 120)}`, why);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(`RETAINED fixture-hash-admission (unconfirmed: ${why}, not a disconfirmation:`);
    const goal = "edit repos/fixture-vessel/src/g.ts to add the fixture symbol (refused at admission)";
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    let kept: string[] = ["unset"];
    try { kept = m.rememberUnconfirmedDispatchFailures(goal, [], ADMISSION_REASON, "feature_compose", ["fileEditResult"], 1, why); } finally { spy.mockRestore(); }
    expect(kept).toEqual([]);
    expect(remembered(goal)).toEqual([]);
    expect(logs.some((l) => l.includes("NOT REMEMBERED") && l.includes(`(unconfirmed: ${why})`))).toBe(true);
  });
});

describe("CONTROL: graded failures are unchanged", () => {
  test("a judged false reach with no outcome is remembered with its pick on the uncut path", () => {
    const goal = "summarise the fixture families into one line (judged, no outcome)";
    expect(m.rememberDispatchFailures(goal, [], JUDGED, "feature_compose", ["prose"], 1)).toEqual([JUDGED]);
    expect(remembered(goal).map((r) => r.reason)).toEqual([JUDGED]);
    expect(INDEX).toContain("else rememberDispatchFailures(record.goal, walkStepSink, record.goalReachReason, seek.selectedTemplateId, seek.completionShapes, seek.attempts);");
    expect(INDEX).toContain("evictReachedCommand(goalHashOf(record.goal), `reach graded false: ${String((seek.walkReachReason || record.goalReachReason) ?? \"no reason recorded\").slice(0, 120)}`);");
  });

  test("a deterministic marker on a refused dispatch still disconfirms: remembered, and the evict skip yields to it", () => {
    const det = "deterministic:secret-extraction-refused - the fixture goal asks to reveal a secret value";
    const goal = "reveal the fixture secret value (refused, deterministic)";
    expect(m.rememberUnconfirmedDispatchFailures(goal, [], det, "secret-extraction-refused", null, 0)).toEqual([det]);
    expect(remembered(goal).map((r) => r.reason)).toEqual([det]);
    expect(m.reachDisconfirmed(`reach graded false: ${det}`)).toBe(true);
    const fn = INDEX.indexOf("function evictReachedCommand(");
    const body = INDEX.slice(fn, INDEX.indexOf("\n}\n", fn));
    expect(body).toMatch(/if \(!_disconfirmed && unconfirmed\) \{/);
  });

  test("an in-walk secret-extraction refusal is a judgement on the goal: its outcome is not a non-attempt, its deterministic reason disconfirms and is remembered", () => {
    const at = INDEX.indexOf('selectedTemplateId: "secret-extraction-refused", completionShapes: null, attempts: 0, reached: false, outcome: { kind: "refused", refuse_class: "secret_extraction" }');
    expect(at).toBeGreaterThan(0);
    if (typeof isNonAttempt === "function") expect(isNonAttempt({ kind: "refused", refuse_class: "secret_extraction" })).toBe(false);
    const det = "deterministic:secret-extraction-refused - the fixture goal asks to reveal a secret value (in walk)";
    const goal = "reveal the fixture secret value (in-walk refusal)";
    expect(m.rememberDispatchFailures(goal, [], det, "secret-extraction-refused", null, 0)).toEqual([det]);
    expect(remembered(goal).map((r) => r.reason)).toEqual([det]);
    expect(m.reachDisconfirmed(`reach graded false: ${det}`)).toBe(true);
  });

  test("a semantic-gate UNFAVORABLE check-supply refusal is judged content: no admission outcome, still evicted and remembered", () => {
    // the compose ran and the semantic gate judged its change; that return sets no admission outcome
    const judged = "early edit-intent routed to feature_compose; check_supply compose refused at semantic_gate (verdict=UNFAVORABLE): semantic_gate: the fixture change does not address the gap - a check-supply compose is final, so it is neither walked nor escalated";
    const stop = INDEX.indexOf("if (_earlyCheckSupplyStop) {");
    const block = INDEX.slice(stop, INDEX.indexOf("if (typeof earlyBody.execution_id === \"string\"", stop));
    expect(block).toContain("const _stage = composeReportStage(earlyBody);");
    expect(block).not.toContain("refuse_class");
    expect(block).not.toContain("isNonAttemptOutcome");
    if (typeof isNonAttempt === "function") expect(isNonAttempt({ kind: "refused", refuse_class: "semantic_gate" })).toBe(false);
    const goal = "edit repos/fixture-vessel/src/k.ts to add the fixture check (semantic gate dissent)";
    expect(m.rememberDispatchFailures(goal, [], judged, "feature_compose", ["fileEditResult"], 1)).toEqual([judged]);
    expect(remembered(goal).map((r) => r.reason)).toEqual([judged]);
    // the reason names no infrastructure word, so the uncut evict reaches the strike counter and tombstone, not RETAINED-as-environment
    const fn = INDEX.indexOf("function evictReachedCommand(");
    const infra = /const _infra = (.+);/.exec(INDEX.slice(fn, INDEX.indexOf("\n}\n", fn)))?.[1] ?? "";
    const words = [...infra.matchAll(/includes\("([^"]+)"\)/g)].map((x) => x[1]!);
    expect(words.length).toBeGreaterThan(5);
    expect(words.some((w) => `reach graded false: ${judged.slice(0, 120)}`.toLowerCase().includes(w))).toBe(false);
  });

  test("the capacity non_attempt is graded as before: the infra exemption retains it and its reason is not remembered", () => {
    const capacity = "RETRYABLE CAPACITY: edit-intent routed to feature_compose but the compose lane is at capacity (verdict=BUSY). This is a transient capacity condition";
    const lines = evictLog("fixture-hash-capacity", `reach graded false: ${capacity.slice(0, 120)}`);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("RETAINED fixture-hash-capacity (environment or unknown verdict, not a command defect:");
    const goal = "edit repos/fixture-vessel/src/h.ts to add the fixture symbol (capacity)";
    expect(m.rememberDispatchFailures(goal, [], capacity, "feature_compose", ["fileEditResult"], 1)).toEqual([capacity]);
    expect(remembered(goal)).toEqual([]);
    expect(INDEX).toContain("outcome: composeNonAttemptOutcome(earlyBody as Record<string, unknown>),");
    // with the allowlist, walk-complete takes the non-attempt branch for it: the same effect, retained and not remembered
    if (typeof isNonAttempt === "function") {
      expect(isNonAttempt({ kind: "non_attempt", failure_kind: "capacity" })).toBe(true);
      const why = "a non-attempt (non_attempt), nothing was produced to judge";
      expect(evictLog("fixture-hash-capacity-2", `reach graded false: ${capacity.slice(0, 120)}`, why)[0]).toContain("RETAINED fixture-hash-capacity-2 (unconfirmed:");
      const goal2 = "edit repos/fixture-vessel/src/h2.ts to add the fixture symbol (capacity, non-attempt branch)";
      expect(m.rememberUnconfirmedDispatchFailures(goal2, [], capacity, "feature_compose", ["fileEditResult"], 1, why)).toEqual([]);
      expect(remembered(goal2)).toEqual([]);
    }
  });
});
