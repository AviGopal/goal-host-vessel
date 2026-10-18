// OBSERVE IS SIDE-EFFECT-FREE — THE REMAINING WRITES (follow-ups to observe-mode-wiring.test.ts). Each block names a
// write an observe dispatch still made after the first pass, read on the source: index.ts boots a server on import, so
// its side-effect functions are pinned on the source, and the pure parts are called through observe-mode.ts (imported
// as a namespace, so a missing export reads as a named failure rather than a link error).
// Controls: the learn path keeps its write after the guard (the guard is observeSkip, whose learn/absent answer is
// false: observe-mode.test.ts (b)), and the pure helpers leave a learn dispatch's data unchanged.
import { afterEach, describe, expect, test } from "bun:test";

import * as om from "../src/observe-mode";
import { isWalkEgressRefused, setWalkEgressLearningModeReader, walkEgressFetch } from "../src/walk-egress-guard";
import { buildResolvePointer } from "../src/resolve-pointer";
import { walkResolveBody } from "../src/applied-write";

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

describe("N2 transform oracle: a verified observe reach writes no expectation note and mints no trend commitment", () => {
  const oracle = (): string => {
    const i = src.indexOf("{ let dtFamily = \"\"; let dtOperand = \"\";");
    expect(i).toBeGreaterThan(0);
    return src.slice(i, src.indexOf("\n", i));
  };
  test("[MUST-FAIL] both memoryNote_write POSTs sit behind the observe guard", () => {
    const o = oracle();
    const guard = o.indexOf('if (dtReached) { if (nt && nt[1] && !observeSkip("artifact_expectation")) { void (async () => {');
    expect(guard).toBeGreaterThan(0);
    const writes = [...o.matchAll(/type: "memoryNote_write"/g)].map((m) => m.index ?? -1);
    expect(writes.length).toBe(2); // the expectation record and the trend commitment
    for (const w of writes) expect(w).toBeGreaterThan(guard);
    expect(o.indexOf('const trendTitle = "expectation-trend:" + dtFamily;')).toBeGreaterThan(guard);
  });
  test("control (learn): the verdict reads before the guard and the verdict returns are unchanged", () => {
    const o = oracle();
    const guard = o.indexOf('!observeSkip("artifact_expectation")');
    expect(o.indexOf("dtReached = typeof nb === \"string\" && nb.trim() === dtExpected;")).toBeLessThan(guard);
    expect(o).toContain("return { reached: true, reason: `deterministic:transform-verified");
    expect(o).toContain("return { reached: false, reason: `deterministic:transform-mismatch");
  });
});

describe("N5 would-be ops: an observe dispatch's record carries them as a structured field", () => {
  const rec = (verdict: string, body: unknown) => (om as any).observeComposeRecord?.(verdict, body);
  test("[MUST-FAIL] observeComposeRecord keeps each op's kind, path and range, and bounds its text", () => {
    const long = "x".repeat(1000);
    const r = rec("FAVORABLE", { verdict: "FAVORABLE", would_be_ops: [
      { kind: "edit", path: "repos/v/src/a.ts", old_string: "a", new_string: long },
      { kind: "replace_lines", path: "repos/v/src/b.ts", start_line: 3, end_line: 5, new_string: "y" },
    ] });
    expect(r?.observe?.landed).toBe(false);
    expect(r?.observe?.verdict).toBe("FAVORABLE");
    expect(r?.observe?.would_be_ops_total).toBe(2);
    expect(r?.observe?.would_be_ops[0]).toEqual({ kind: "edit", path: "repos/v/src/a.ts", old_string: "a", new_string: "x".repeat(240), new_string_chars: 1000 });
    expect(r?.observe?.would_be_ops[1]).toEqual({ kind: "replace_lines", path: "repos/v/src/b.ts", start_line: 3, end_line: 5, new_string: "y" });
    const many = rec("FAVORABLE", { would_be_ops: Array.from({ length: 50 }, (_, i) => ({ kind: "edit", path: `p${i}` })) });
    expect(many?.observe?.would_be_ops.length).toBe(20);
    expect(many?.observe?.would_be_ops_total).toBe(50);
  });
  test("[MUST-FAIL] a compose that answered no ops (or not OK) records an empty list, never a fabricated one", () => {
    expect(rec("", null)?.observe).toEqual({ landed: false, verdict: "(none)", would_be_ops: [], would_be_ops_total: 0 });
    expect(rec("UNFAVORABLE", { would_be_ops: "not-a-list" })?.observe?.would_be_ops).toEqual([]);
  });
  test("[MUST-FAIL] all three observe returns carry it, /run-goal puts it on the record, GET /executions/:id serves it", () => {
    expect(src.match(/\.\.\.observeComposeOutcome\([^\n]*\), \.\.\.observeComposeRecord\(/g)?.length).toBe(3);
    expect(src).toContain("...observeComposeRecord(earlyVerdict, earlyBody) };");
    expect(src).toContain("...observeComposeRecord(verdict, body) };");
    expect(src).toContain('...observeComposeRecord("(none)", null) };');
    expect(src).toContain("if (seek.observe) record.observe = seek.observe;");
    const get = src.indexOf('if (req.method === "GET" && url.pathname.startsWith("/executions/")) {');
    expect(src.slice(get, get + 5000)).toContain("observe: record.observe ?? null,");
  });
  test("control (learn): a learn dispatch never reaches those returns, so its record has no observe field", () => {
    // each return sits inside its `if (opts.learningMode === "observe")` block (observe-mode-wiring.test.ts pins the blocks)
    for (const call of ["...observeComposeRecord(earlyVerdict, earlyBody) };", "...observeComposeRecord(verdict, body) };", '...observeComposeRecord("(none)", null) };']) {
      const i = src.indexOf(call);
      expect(i - src.lastIndexOf('if (opts.learningMode === "observe") {', i)).toBeLessThan(800);
    }
  });
});

describe("scope: an observe walk never dispatches a resolver that ignores the mode", () => {
  const realFetch = globalThis.fetch;
  let calls: string[] = [];
  const stubFetch = () => {
    calls = [];
    globalThis.fetch = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response("{}", { status: 200 }); }) as typeof fetch;
  };
  afterEach(() => { globalThis.fetch = realFetch; setWalkEgressLearningModeReader(() => undefined); om.resetObserveSkips(); });
  const init = (pointer: Record<string, unknown>): RequestInit => ({ method: "POST", body: JSON.stringify({ impulse: { pointer } }) });
  const send = async (mode: string, shape: string, pointer: Record<string, unknown>): Promise<unknown> => {
    setWalkEgressLearningModeReader(() => ({ learningMode: mode, dispatchId: `d-${mode}` }));
    try { await walkEgressFetch(shape, "http://dv/v2/impulses/resolve", init(pointer)); return null; } catch (e) { return e; }
  };
  const BLIND = ["gap_to_feature", "apply_proposal_as_patch", "perf_canary_resolve", "patch_with_tools", "goal_execution"];

  test("[MUST-FAIL] observe: each mode-blind resolver is refused before fetch, bare or vessel-qualified, by site or body", async () => {
    stubFetch();
    for (const s of BLIND) {
      expect(isWalkEgressRefused(await send("observe", s, { type: s, gap_id: "g" }))).toBe(true);
      expect(isWalkEgressRefused(await send("observe", "x", { type: `development-vessel:${s}` }))).toBe(true);
    }
    expect(calls).toEqual([]);
    expect(om.observeSkipCounters()).toEqual({ mode_blind_dispatch: BLIND.length * 2 });
  });
  test("[MUST-FAIL] observe: a walk-built feature_compose / gap_compose pointer without learning_mode observe is refused", async () => {
    stubFetch();
    expect(isWalkEgressRefused(await send("observe", "feature_compose", { type: "feature_compose", spec: "s", land: true }))).toBe(true);
    expect(isWalkEgressRefused(await send("observe", "gap_compose", { type: "gap_compose", spec: "s", learning_mode: "learn" }))).toBe(true);
    expect(calls).toEqual([]);
    const why = (om as any).observeModeBlindRefusal?.("observe", "patch_with_tools", {});
    expect(why).toContain("would-be op");
  });
  test("control: observe lets a compose that carries learning_mode observe, and ordinary reads, go out", async () => {
    stubFetch();
    expect(await send("observe", "feature_compose", { type: "feature_compose", spec: "s", learning_mode: "observe", land: false })).toBeNull();
    expect(await send("observe", "memoryNote", { type: "memoryNote", title_prefix: "x" })).toBeNull();
    expect(calls.length).toBe(2);
  });
  test("control (learn / absent): every one of them goes out unchanged", async () => {
    stubFetch();
    for (const s of [...BLIND, "feature_compose", "gap_compose"]) expect(await send("learn", s, { type: s })).toBeNull();
    setWalkEgressLearningModeReader(() => undefined);
    await walkEgressFetch("patch_with_tools", "http://dv/v2/impulses/resolve", init({ type: "patch_with_tools" }));
    expect(calls.length).toBe(BLIND.length + 3);
    expect(om.observeSkipCounters()).toEqual({});
  });
});

describe("gapDecomposition: an observe walk's decomposition runs dry, and one that would run as learn is refused", () => {
  const realFetch = globalThis.fetch;
  let sent: unknown[] = [];
  const stubFetch = () => {
    sent = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body ?? "null"))); return new Response("{}", { status: 200 }); }) as typeof fetch;
  };
  afterEach(() => { globalThis.fetch = realFetch; setWalkEgressLearningModeReader(() => undefined); om.resetObserveSkips(); });
  const decomposeFields = (shape: string, mode: unknown) => (om as any).observeDecomposeFields?.(shape, mode);
  /** The walk's satisfier egress for a shape, as rawResolve builds it: pointer from pool + args, the observe stamp, the body. */
  const walkEgress = async (mode: string, extraArgs: Record<string, unknown>): Promise<unknown> => {
    setWalkEgressLearningModeReader(() => ({ learningMode: mode, dispatchId: `d-${mode}` }));
    const pointer = buildResolvePointer("gapDecomposition", { dispatch_id: `d-${mode}` }, extraArgs);
    Object.assign(pointer, decomposeFields("gapDecomposition", mode) ?? {});
    try { await walkEgressFetch("gapDecomposition", "http://dv/v2/impulses/resolve", { method: "POST", body: JSON.stringify(walkResolveBody("gapDecomposition", pointer)) }); return null; } catch (e) { return e; }
  };

  test("[MUST-FAIL] observe: the walk's gapDecomposition pointer carries learning_mode observe and goes out", async () => {
    stubFetch();
    expect(decomposeFields("gapDecomposition", "observe")).toEqual({ learning_mode: "observe" });
    expect(decomposeFields("development-vessel:gapDecomposition", "observe")).toEqual({ learning_mode: "observe" });
    expect(await walkEgress("observe", { decompose_gap_id: "g-1" })).toBeNull();
    expect(sent).toEqual([{ impulse: { pointer: { dispatch_id: "d-observe", decompose_gap_id: "g-1", type: "gapDecomposition", learning_mode: "observe" } } }]);
    // a synthesised arg cannot turn it back to learn: the stamp is applied after the pointer is built
    stubFetch();
    expect(await walkEgress("observe", { decompose_gap_id: "g-1", learning_mode: "learn" })).toBeNull();
    expect((sent[0] as any).impulse.pointer.learning_mode).toBe("observe");
  });
  test("[MUST-FAIL] observe: a gapDecomposition egress whose pointer lacks learning_mode observe is refused before fetch", async () => {
    stubFetch();
    setWalkEgressLearningModeReader(() => ({ learningMode: "observe", dispatchId: "d-obs" }));
    let err: unknown = null;
    try { await walkEgressFetch("gapDecomposition", "http://dv/v2/impulses/resolve", { method: "POST", body: JSON.stringify({ impulse: { pointer: { type: "gapDecomposition", decompose_gap_id: "g-1" } } }) }); } catch (e) { err = e; }
    expect(isWalkEgressRefused(err)).toBe(true);
    expect(String((err as Error)?.message)).toContain("would-be op");
    expect(sent).toEqual([]);
    expect(om.observeSkipCounters()).toEqual({ mode_blind_dispatch: 1 });
    expect((om as any).OBSERVE_MODE_BLIND_SHAPES?.has("gapDecomposition")).toBe(false); // runnable, not blind
  });
  test("[MUST-FAIL] rawResolve stamps the walk's pointer after it is built and before the egress", () => {
    const body = fnBody("const rawResolve = async (shape: string, endpoint: string, resolvePath: string, extraArgs: Record<string, unknown>, site = \"walk\")", 12000);
    const built = body.indexOf("const pointer: Record<string, unknown> = buildResolvePointer(shape, base as Record<string, unknown>, extraArgs);");
    const stamp = body.indexOf("Object.assign(pointer, observeDecomposeFields(shape, opts.learningMode));");
    expect(built).toBeGreaterThan(0);
    expect(stamp).toBeGreaterThan(built);
    expect(stamp).toBeLessThan(body.indexOf("resp = await walkEgressFetch(shape,"));
    expect(src).toContain("directArgsRaw = { decompose_gap_id: gid };");
  });
  test("control (learn / absent): the pointer is unchanged and goes out", async () => {
    stubFetch();
    expect(decomposeFields("gapDecomposition", "learn")).toEqual({});
    expect(decomposeFields("gapDecomposition", undefined)).toEqual({});
    expect(decomposeFields("feature_compose", "observe")).toEqual({});
    expect(await walkEgress("learn", { decompose_gap_id: "g-1" })).toBeNull();
    expect(sent).toEqual([{ impulse: { pointer: { dispatch_id: "d-learn", decompose_gap_id: "g-1", type: "gapDecomposition" } } }]);
    expect(om.observeSkipCounters()).toEqual({});
  });
});
