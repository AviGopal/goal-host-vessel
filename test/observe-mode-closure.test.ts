// OBSERVE IS SIDE-EFFECT-FREE — THE REMAINING WRITES (follow-ups to observe-mode-wiring.test.ts). Each block names a
// write an observe dispatch still made after the first pass, read on the source: index.ts boots a server on import, so
// its side-effect functions are pinned on the source, and the pure parts are called through observe-mode.ts (imported
// as a namespace, so a missing export reads as a named failure rather than a link error).
// Controls: the learn path keeps its write after the guard (the guard is observeSkip, whose learn/absent answer is
// false: observe-mode.test.ts (b)), and the pure helpers leave a learn dispatch's data unchanged.
import { describe, expect, test } from "bun:test";

import * as om from "../src/observe-mode";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const fnBody = (sig: string, span = 2500): string => {
  const i = src.indexOf(sig);
  expect(i).toBeGreaterThan(0);
  return src.slice(i, i + span);
};

describe("B1 alpha credit: creditReachedTemplate POSTs no α under observe", () => {
  test("[MUST-FAIL] the observe guard is its first statement, before the credit hold and the feedback POST", () => {
    const body = fnBody("async function creditReachedTemplate(", 3000);
    const guard = body.indexOf('if (observeSkip("alpha_credit")) return { templateId: activityId, dAlpha: 0, dBeta: 0 };');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(body.indexOf("creditHold.heldForGoal("));
    expect(guard).toBeLessThan(body.indexOf("/v2/activities/feedback"));
  });
  test("control (learn): the positive feedback POST is still there, and both call sites still credit", () => {
    const body = fnBody("async function creditReachedTemplate(", 3000);
    expect(body).toContain('direction: "positive", intensity: 2');
    expect(src.match(/await creditReachedTemplate\(/g)?.length).toBe(2);
  });
});

describe("B2 traces: every trace goal-host persists for an observe dispatch carries learning_mode:observe", () => {
  const tagsOf = (mode: unknown, tags?: string[]) => (om as any).observeTraceTags?.(tags, mode);
  test("[MUST-FAIL] observeTraceTags adds the tag once under observe", () => {
    expect(tagsOf("observe", ["dispatcher_used:goal-host"])).toEqual(["dispatcher_used:goal-host", "learning_mode:observe"]);
    expect(tagsOf("observe", undefined)).toEqual(["learning_mode:observe"]);
    expect(tagsOf("observe", ["learning_mode:observe", "reached:false"])).toEqual(["learning_mode:observe", "reached:false"]);
  });
  test("[MUST-FAIL] observeTaggingSink stamps a floor-shaped and a failed-walk-shaped trace (neither carried the tag)", async () => {
    const seen: Array<{ id: string; tags?: string[] }> = [];
    const sink = (om as any).observeTaggingSink?.({ record: async (t: { id: string; tags?: string[] }) => { seen.push(t); } }, () => "observe");
    expect(sink).toBeDefined();
    await sink.record({ id: "universal-tool-fallback-x", tags: ["dispatcher_used:goal-host", "reached:false"] });
    await sink.record({ id: "walk-satisfier-failed-x", tags: ["dispatcher_used:goal-host"] });
    await sink.record({ id: "no-tags" });
    expect(seen.map((t) => t.tags)).toEqual([
      ["dispatcher_used:goal-host", "reached:false", "learning_mode:observe"],
      ["dispatcher_used:goal-host", "learning_mode:observe"],
      ["learning_mode:observe"],
    ]);
  });
  test("control (learn / absent): the tags and the trace object reach the sink unchanged", async () => {
    expect(tagsOf("learn", ["a"])).toEqual(["a"]);
    expect(tagsOf(undefined, undefined)).toBeUndefined();
    const seen: unknown[] = [];
    for (const mode of ["learn", undefined]) {
      const sink = (om as any).observeTaggingSink?.({ record: async (t: unknown) => { seen.push(t); } }, () => mode);
      const trace = { id: "t", tags: ["dispatcher_used:goal-host"] };
      await sink.record(trace);
      expect(seen.pop()).toBe(trace);
    }
  });
  test("[MUST-FAIL] the one trace sink goal-host builds is wrapped, reading the dispatch context's mode", () => {
    expect(src.match(/new TranslatingTraceSink\(/g)?.length).toBe(1);
    expect(src).toContain('const satisfierTraceSink = observeTaggingSink(new TranslatingTraceSink(ACTIVITY_API_ENDPOINT, API_KEY ?? ""), () => dispatchContext.getStore()?.learningMode);');
  });
  test("the floor and the failed walk persist through that sink; engine traces carry the dispatch's tags", () => {
    // floor + failed walk -> persistSatisfierTrace -> satisfierTraceSink.record
    expect(fnBody("async function persistSatisfierTrace(", 900)).toContain("await satisfierTraceSink.record(trace);");
    expect(fnBody("async function persistFailedWalkTrace(", 600)).toContain("await persistSatisfierTrace({");
    expect(src).toContain('templateId: "universal-tool-fallback",');
    // engine (template) traces: the walk and the recovery loop pass the dispatch's tags, which /run-goal stamps
    expect(src.match(/host\.runTemplate\([^)]*\{[\s\S]{0,260}?tags: opts\.tags,/g)?.length).toBe(2);
    expect(src).toContain("tags: [...(opts.tags ?? []), ...correlationTag(pickCorrelationId)],");
    const stamp = src.indexOf("if (learningMode) effectiveTags.push(`learning_mode:${learningMode}`);");
    expect(stamp).toBeGreaterThan(0);
    const run = src.indexOf("const seek = await runGoalWithRecovery(goal, {", stamp);
    expect(run).toBeGreaterThan(stamp);
    expect(src.slice(run, run + 400)).toContain("tags: effectiveTags,");
  });
});

describe("B3 boot: an interrupted observe dispatch resumes as observe and is not reconciled into the corpus", () => {
  const boot = (): string => {
    const i = src.indexOf("const saved = JSON.parse(await Bun.file(DISPATCH_STORE_PATH).text()) as DispatchRecord[];");
    expect(i).toBeGreaterThan(0);
    return src.slice(i, src.indexOf("function persistDispatchStore(): void {", i));
  };
  test("[MUST-FAIL] the boot resume POST carries the record's learning mode", () => {
    const b = boot();
    const post = b.indexOf('fetch("http://127.0.0.1:" + PORT + "/run-goal"');
    expect(post).toBeGreaterThan(0);
    expect(b.slice(post, post + 400)).toContain('tags: ["resumed_from:" + old.dispatchId], ...(old.learningMode ? { learning_mode: old.learningMode } : {}) })');
  });
  test("[MUST-FAIL] the edit-intent reconciliation (verdict + recordDeterministicLabel) is skipped for an observe record", () => {
    const b = boot();
    const gate = b.indexOf('if (typeof r.goal === "string" && /edit repos\\//i.test(r.goal) && !observeSkips(r.learningMode, r.dispatchId, "oracle_label")) {');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(b.indexOf("recordDeterministicLabel("));
    expect(gate).toBeLessThan(b.indexOf('r.status = "completed"; r.reached = true;'));
  });
  test("control (learn): the reconciliation still labels, the record still persists its mode, the requeue still carries it", () => {
    const b = boot();
    expect(b).toContain("recordDeterministicLabel(");
    expect(b).toContain("if (!reconciled) { interruptedRequeue.push(r); }");
    expect(src).toMatch(/interface DispatchRecord \{[\s\S]{0,600}?\n  learningMode\?: "observe" \| "learn";/);
    expect(src).toContain("dispatchId: r.dispatchId, ...(r.learningMode ? { learning_mode: r.learningMode } : {}) })");
    // observeSkips is false for learn/absent (observe-mode.test.ts (b)), so a learn record reconciles as before
    expect(om.observeSkips("learn", "d", "oracle_label", () => {})).toBe(false);
    expect(om.observeSkips(undefined, "d", "oracle_label", () => {})).toBe(false);
  });
});

describe("N1 landed latch: an observe dispatch returns before the latch", () => {
  const latch = (): string => fnBody("async function runGoalWithRecovery(", 5000);
  test("[MUST-FAIL] the observe return precedes the latch's git probe, its wait and its landed verdict", () => {
    const b = latch();
    const obs = b.indexOf('if (opts.learningMode === "observe") return r;');
    expect(obs).toBeGreaterThan(b.indexOf("const r = await runGoalWithRecoveryInner(goal, opts);"));
    expect(obs).toBeLessThan(b.indexOf("let sha = await landedCommitForGoal("));
    expect(obs).toBeLessThan(b.indexOf("await new Promise((res) => setTimeout(res, 30_000));"));
    expect(obs).toBeLessThan(b.indexOf("recordDeterministicLabel(goal, `feature_compose:${sha}`"));
  });
  test("control (learn): the latch itself is unchanged, and the post-walk compose still arms it", () => {
    const b = latch();
    expect(b).toContain('if (r.reached === true || typeof goal !== "string" || !_dispatchSentCompose.has(opts)) return r;');
    expect(b).toContain("reached: true,\n    executionId: `feature_compose:${sha}`,");
    expect(src).toContain("_dispatchSentCompose.set(opts, Date.now());");
  });
});
