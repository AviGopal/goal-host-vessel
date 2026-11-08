// A TEMPLATE WHOSE PRODUCT CARRIES ITS OWN VERDICT IS GRADED BY IT (src/template-reach-rule.ts).
//
// A pinned run of development-vessel:own-check-baseline produced an ownCheckBaseline impulse (verdict
// red_code_reachable) and the engine-path reach gate handed it to the LLM judge, which graded it HOLLOW ("does not
// provide a measurement") and β-penalised the template. For that template the reach is now its product's verdict:
// reached iff an ownCheckBaseline impulse carries a verdict in the closed set, the judge is skipped, and the walk log
// names the rule that decided.
//
//   [MUST-FAIL] own-check-baseline run with verdict red_code_reachable → reached, the rule named in the walk log
//               (red by assertion at the parent: the judge is consulted, its fetch is refused, reached stays false)
//   [MUST-FAIL] the rule itself (new module): the closed set reaches, off-set and absent do not
//   [CONTROL]   no ownCheckBaseline impulse → not reached, decided by the rule (verdict=none)
//   [CONTROL]   an off-set verdict ("pending") → not reached, decided by the rule
//   [CONTROL]   another template → no rule; the existing judge path grades it (the judge is called)
//
// runGoalWithRecovery is DRIVEN as in failed-trace-reason.test.ts: a pinned first target with maxAttempts 1, and
// GoalHost.prototype.runGoal spied to put the run's output impulse into the host's store and return the trace.
// Hermetic: fetch is stubbed to refuse for the whole file (restored after); learningMode observe writes no β/α/label.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "template-reach-rule-"));
process.env["GOAL_FAILURE_MEMORY_PATH"] ||= join(TMP, "failure-memory.jsonl");
process.env["REACHED_CMD_CACHE_PATH"] ||= join(TMP, "reached-commands.jsonl");
process.env["REACH_VERDICT_SPOOL_PATH"] ||= join(TMP, "reach-spool.jsonl");
process.env["MEM_DUMP_PATH"] ||= join(TMP, "mem-dump.json");
process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";

const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new TypeError("fetch refused (test: no network)"); }) as unknown as typeof fetch);
const { GoalHost, InMemoryTemplateProvider } = await import("@avigopal/ias-executor-ts");
const m = await import("../src/index");

afterAll(() => {
  fetchSpy.mockRestore();
  rmSync(TMP, { recursive: true, force: true });
});

const OCB = "development-vessel:own-check-baseline";
let seq = 0;
async function runPinned(templateId: string, outputs: Array<{ shape: string; content: unknown }>) {
  const n = ++seq;
  const spy = spyOn(GoalHost.prototype as unknown as { runGoal: (...a: unknown[]) => Promise<unknown> }, "runGoal").mockImplementation(async function (this: { runtime: { store: { create(i: unknown): unknown } } }) {
    const ids = outputs.map((o, i) => {
      const id = `imp-trr-${n}-${i}`;
      this.runtime.store.create({ id, pointer: { type: o.shape }, metadata: { shape: o.shape }, loaded: true, content: o.content });
      return id;
    });
    return {
      selectedTemplateId: templateId,
      trace: { id: `exec-trr-${n}`, status: "completed", tasks: [{ taskId: "classify", resolverId: "ownCheckBaseline", success: true, outputShapes: outputs.map((o) => o.shape), outputImpulseIds: ids }] },
    };
  });
  // FIXTURE: the pinned template is in the host's catalogue (a pin the dispatcher cannot fetch goes through the walk
  // instead, agf_7b4l8praaak5); the first catalogue lookup of the id registers it in that catalogue.
  const _origGet = InMemoryTemplateProvider.prototype.getTemplate;
  const catalogueSpy = spyOn(InMemoryTemplateProvider.prototype, "getTemplate").mockImplementation(async function (this: InstanceType<typeof InMemoryTemplateProvider>, id: string) {
    if (id === templateId) this.register({ id, name: id, tasks: [] });
    return _origGet.call(this, id);
  });
  const stepSink: string[] = [];
  // The judge chain's own log lines (verifyGoalReachedUnrestricted's oracles log as they decline): proof it ran.
  const logged: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
  try {
    const r = await m.runGoalWithRecovery(`measure the own check of gap g-trr-${n} at its base`, { firstTarget: templateId, callerPinned: true, maxAttempts: 1, variables: {}, surface: "test", stepSink, learningMode: "observe" } as never);
    return { r, stepSink, judged: logged.some((l) => l.startsWith("[ephemeris-oracle]")) };
  } finally {
    logSpy.mockRestore();
    spy.mockRestore();
    catalogueSpy.mockRestore();
  }
}

const baseline = (verdict: string) => ({
  shape: "ownCheckBaseline",
  content: { shape: "ownCheckBaseline", body: { gap_id: "g-trr", vessel: "goal-host-vessel", test_file: "test/x.test.ts", only_tests: [], base_sha: "0".repeat(40), verdict, red: ["x"], failing: [], expect_count: 1, call_path: [], call_path_source: null, env_signals: [], env_policy: "policy", dispatch_id: null, measured_at: "2026-11-01T00:00:00.000Z", written: true } },
});
const ruleLine = (sink: string[]) => sink.find((l) => l.includes(`DETERMINISTIC via ${OCB}: rule=own_check_baseline_verdict`));

describe("development-vessel:own-check-baseline is graded by its product's verdict", () => {
  test("[MUST-FAIL] a run whose ownCheckBaseline verdict is red_code_reachable is reached, and the rule is named", async () => {
    const { r, stepSink, judged } = await runPinned(OCB, [baseline("red_code_reachable")]);
    expect(r.reached).toBe(true);
    expect(judged).toBe(false);
    expect(r.status).toBe("completed");
    expect(ruleLine(stepSink)).toContain("reached=true (verdict=red_code_reachable)");
    expect(stepSink.some((l) => l.includes(`REACHED via ${OCB} — deterministic:template-reach-rule`))).toBe(true);
    expect(stepSink.some((l) => l.includes("HOLLOW via"))).toBe(false);
  });

  test("[CONTROL] no ownCheckBaseline impulse: not reached, decided by the rule", async () => {
    const { r, stepSink } = await runPinned(OCB, [{ shape: "testSuiteReport", content: { ran: true, verdict: "green_at_parent" } }]);
    expect(r.reached).toBe(false);
    expect(ruleLine(stepSink)).toContain("reached=false (verdict=none)");
    expect(r.goalReachReason).toContain("produced no ownCheckBaseline impulse");
  });

  test("[CONTROL] an off-set verdict (pending): not reached, decided by the rule", async () => {
    const { r, stepSink } = await runPinned(OCB, [baseline("pending")]);
    expect(r.reached).toBe(false);
    expect(ruleLine(stepSink)).toContain("reached=false (verdict=pending)");
  });

  test("[CONTROL] another template has no rule: the existing judge grades it", async () => {
    const { r, stepSink, judged } = await runPinned("development-vessel:some-other-template", [baseline("red_code_reachable")]);
    expect(stepSink.some((l) => l.includes("DETERMINISTIC via"))).toBe(false);
    expect(r.reached).toBe(false);
    // The judge chain ran (its first oracle logged its decline before the LLM judge was asked).
    expect(judged).toBe(true);
  });
});

describe("the rule (template-reach-rule.ts)", () => {
  test("[MUST-FAIL] the closed set reaches; off-set, absent and other templates do not", async () => {
    const { templateReachVerdict } = await import("../src/template-reach-rule");
    for (const v of ["green_at_parent", "red_code_reachable", "red_environmental", "unrunnable"]) {
      const got = templateReachVerdict(OCB, [baseline(v)]);
      expect(got?.reached).toBe(true);
      expect(got?.deterministic).toBe(true);
      expect(got?.completion_shapes).toEqual(["ownCheckBaseline"]);
      expect(got?.reason).toMatch(/^deterministic:[\w-]+/);
    }
    // the bare body and a vessel-qualified shape read the same
    expect(templateReachVerdict(OCB, [{ shape: "development-vessel:ownCheckBaseline", content: { verdict: "unrunnable" } }])?.reached).toBe(true);
    expect(templateReachVerdict(OCB, [baseline("pending")])?.reached).toBe(false);
    expect(templateReachVerdict(OCB, [])?.value).toBe("none");
    expect(templateReachVerdict(OCB, undefined)?.reached).toBe(false);
    expect(templateReachVerdict("development-vessel:some-other-template", [baseline("green_at_parent")])).toBeNull();
    expect(templateReachVerdict(undefined, [baseline("green_at_parent")])).toBeNull();
  });
});
