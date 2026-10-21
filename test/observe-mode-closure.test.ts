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
import * as ca from "../src/composite-authoring";
import { configureCreditHold, heldFor, readStatusSync, DEPLOYED_CORPUS_DIR, HOLD_CACHE_TTL_MS } from "../src/judge/credit-hold";
import { makeForeignConsumptionGate } from "../src/foreign-consumption-gate";

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
    // The boot resume runs in process as the node's own identity (src/inbound-auth.ts): no HTTP POST to its own /run-goal.
    const post = b.indexOf('runGoalAs(SELF_PRINCIPAL, { goal: old.goal');
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
  test("control: observe lets an ordinary read go out", async () => {
    stubFetch();
    expect(await send("observe", "memoryNote", { type: "memoryNote", title_prefix: "x" })).toBeNull();
    expect(calls.length).toBe(1);
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

describe("commit 9: no auto-draft under observe, and a walk-built compose is refused whatever mode its pointer claims", () => {
  test("[MUST-FAIL] autoDraft returns under observe before the recommend, the scenario write and the drafter run", () => {
    const body = fnBody("const autoDraft = async (): Promise<void> => {", 20000);
    const guard = body.indexOf('if (observeSkip("auto_draft")) return;');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(body.indexOf("/v2/activities/recommend"));
    expect(guard).toBeLessThan(body.indexOf("body: fsWriteBody,"));
    expect(guard).toBeLessThan(body.indexOf('targetTemplateId: "activity:⟨development-vessel:draft-gap-closing-activity⟩",'));
  });
  test("control (learn): autoDraft is unchanged after the guard (its env gate first, then the drafter run)", () => {
    const body = fnBody("const autoDraft = async (): Promise<void> => {", 20000);
    expect(body.indexOf('process.env.SUBSTRATE_AUTO_DRAFT_ENABLED === "0"')).toBeLessThan(body.indexOf('observeSkip("auto_draft")'));
    expect(body).toContain('tags: ["substrate.auto.draft", `auto_draft_for_dispatch:${dispatchId}`],');
    expect(src).toContain("await autoDraft();");
  });

  const realFetch = globalThis.fetch;
  let calls: string[] = [];
  const stubFetch = () => {
    calls = [];
    globalThis.fetch = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response("{}", { status: 200 }); }) as typeof fetch;
  };
  afterEach(() => { globalThis.fetch = realFetch; setWalkEgressLearningModeReader(() => undefined); om.resetObserveSkips(); });
  const send = async (mode: string, shape: string, pointer: Record<string, unknown>): Promise<unknown> => {
    setWalkEgressLearningModeReader(() => ({ learningMode: mode, dispatchId: `d-${mode}` }));
    try { await walkEgressFetch(shape, "http://dv/v2/impulses/resolve", { method: "POST", body: JSON.stringify({ impulse: { pointer } }) }); return null; } catch (e) { return e; }
  };
  test("[MUST-FAIL] observe: a walk-built compose whose pointer claims learning_mode observe is still refused before fetch", async () => {
    stubFetch();
    for (const s of ["feature_compose", "gap_compose"]) {
      const e = await send("observe", s, { type: s, spec: "s", learning_mode: "observe", land: false });
      expect(isWalkEgressRefused(e)).toBe(true);
      expect(String((e as Error)?.message)).toContain("whatever mode its pointer carries");
      expect(isWalkEgressRefused(await send("observe", "x", { type: `development-vessel:${s}`, learning_mode: "observe" }))).toBe(true);
    }
    expect(calls).toEqual([]);
    // composes are refused, not stamped: the walk's stamp is for gapDecomposition only
    expect((om as any).observeDecomposeFields?.("feature_compose", "observe")).toEqual({});
    expect((om as any).observeDecomposeFields?.("gap_compose", "observe")).toEqual({});
  });
  test("control (learn): the same compose pointers go out unchanged", async () => {
    stubFetch();
    for (const s of ["feature_compose", "gap_compose"]) {
      expect(await send("learn", s, { type: s, spec: "s", learning_mode: "observe" })).toBeNull();
      expect(await send("learn", s, { type: s, spec: "s" })).toBeNull();
    }
    expect(calls.length).toBe(4);
    expect(om.observeSkipCounters()).toEqual({});
  });
});

describe("commit 10: template authoring goes through the walk egress door, and every direct dev-vessel send is accounted for", () => {
  const realFetch = globalThis.fetch;
  let sent: Array<{ url: string; init: RequestInit }> = [];
  const stubFetch = (reply: unknown = { body: { minted_activity_id: "m-1", validated: true, input_shapes: ["a"], output_shapes: ["T"] } }) => {
    sent = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => { sent.push({ url: String(url), init: init ?? {} }); return new Response(JSON.stringify(reply), { status: 200 }); }) as typeof fetch;
  };
  afterEach(() => { globalThis.fetch = realFetch; setWalkEgressLearningModeReader(() => undefined); om.resetObserveSkips(); });
  const inMode = (mode: string | undefined) => setWalkEgressLearningModeReader(() => (mode ? { learningMode: mode, dispatchId: `d-${mode}` } : undefined));
  const deps = { resolveUrl: async () => "http://dv/v2/impulses/resolve", apiKey: "k", timeoutMs: 1000 };

  test("[MUST-FAIL] observe: a walk with no pick and a missing target sends no author_producer and no author_composed_capability; counted", async () => {
    stubFetch();
    inMode("observe");
    const ap = (ca as any).authorProducer;
    expect(typeof ap).toBe("function");
    expect(await ap?.("T", "goal", ["a"], "d-observe", deps)).toBeNull();
    const c = await ca.authorComposite("goal", ["T"], ["a"], "d-observe", deps);
    expect(c.ok).toBe(false);
    const r = await ca.retireComposite("m-1", "first run did not reach", deps);
    expect(r.ok).toBe(false);
    expect(sent).toEqual([]);
    expect(om.observeSkipCounters()).toEqual({ authoring_mint: 3 });
  });
  test("[MUST-FAIL] the walk's mint-as-you-go calls authorProducer; no direct author_producer send is left in index.ts", () => {
    expect(src).toContain("const authored = await authorProducer(X, goal, [...producedShapes], dispatchContext.getStore()?.dispatchId, { resolveUrl: async () => `${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, apiKey: API_KEY, timeoutMs: 180_000 });");
    expect(src).not.toContain('impulse: { type: "author_producer"');
    // the composite ledger only learns of a composite the author returned, so an observe dispatch has nothing to retire
    expect(src).toContain("composedByDispatch.note(String(opts.variables?.dispatch_id ?? \"\"), _c.pick);");
    expect(ca.compositesToRetire([], false)).toEqual([]);
  });
  test("control (learn): the exact egress is unchanged — URL, method, headers and body bytes", async () => {
    stubFetch();
    inMode("learn");
    expect(await (ca as any).authorProducer?.("T", "goal", ["a"], "d-learn", deps)).toEqual({ id: "m-1", inputShapes: ["a"] });
    const c = await ca.authorComposite("goal", ["T"], ["a"], "d-learn", deps);
    expect(c.ok).toBe(true);
    stubFetch({});
    inMode(undefined);
    expect((await ca.retireComposite("m-1", "why", deps)).ok).toBe(true);
    const headers = { "Content-Type": "application/json", Authorization: "ApiKey k" };
    expect(sent.map((x) => [x.url, x.init.method, x.init.headers, x.init.body])).toEqual([
      ["http://dv/v2/impulses/resolve", "POST", headers, JSON.stringify({ pointer: { type: "activityTemplate_deprecate", templateId: "m-1", reason: "why" } })],
    ]);
    expect(om.observeSkipCounters()).toEqual({});
  });
  test("control (learn): author_producer and author_composed_capability bodies are the walk's original bytes", async () => {
    stubFetch();
    inMode("learn");
    await (ca as any).authorProducer?.("T", "goal", ["a"], "d-learn", deps);
    await ca.authorComposite("goal", ["T"], ["a"], "d-learn", deps);
    const headers = { "Content-Type": "application/json", Authorization: "ApiKey k" };
    expect(sent.map((x) => [x.url, x.init.method, x.init.headers, x.init.body])).toEqual([
      ["http://dv/v2/impulses/resolve", "POST", headers, JSON.stringify({ impulse: { type: "author_producer", pointer: { type: "author_producer", shape: "T", goal: "goal", available_shapes: ["a"], max_attempts: 3, execution_id: "d-learn" } } })],
      ["http://dv/v2/impulses/resolve", "POST", headers, JSON.stringify({ impulse: { type: "author_composed_capability", pointer: { type: "author_composed_capability", goal: "goal", target_shapes: ["T"], available_shapes: ["a"], max_attempts: 2, execution_id: "d-learn" } } })],
    ]);
  });
  test("[MUST-FAIL] minor: no human solicitation, no template_repair route and no lint-repair template write under observe", () => {
    expect(fnBody("async function solicitHumanInput(", 400)).toContain('if (observeSkip("human_solicitation")) return null;');
    expect(src).toContain('if (process.env.ROUTE_ACTIVITY_REPAIR === "1" && !/repos\\/[\\w.-]+\\//.test(goal) && !observeSkip("authoring_mint")) {');
    expect(fnBody("async function lintAndRepairAuthoredTemplate(", 6000)).toContain('if (changed && !observeSkip("authoring_mint")) {');
  });

  // ── THE CLASS DETECTOR (law 6) ─────────────────────────────────────────────────────────────────────────────────
  // Every direct send to development-vessel's or activity-api's /v2/impulses/resolve in index.ts must be (a) a READ,
  // named below with the shape it reads, (b) observe-guarded (an observeSkip/observeSkips call earlier in the same
  // function, top-level or a nested `const x = async (`, within GUARD_WINDOW chars), or (c) named below as running
  // outside any dispatch, or as stated
  // debt. A new unguarded write fails this test. The lists ARE the debt: they are hand-written, and the step that
  // replaces them is the declared-write-metadata gap (a resolver declares its writes, and the door reads the registry).
  // Limits, stated: proximity is not dominance (a guard on another branch of the same function would satisfy it), and
  // only literal endpoint + /v2/impulses/resolve URLs are scanned (discovery-resolved URLs and the /v2/activities/*
  // routes are not; the walk's own egress goes through walkEgressFetch instead).
  const READS: Record<string, string> = {
    substrateGap: "gap-store read",
    poolImpulse: "pool read",
    memoryNote: "memory read",
    learning_transfer_report: "the mint governor's headroom read",
    thompson_posterior: "satisfier reliability read",
    consumer_productivity_audit: "consumability audit read",
    vesselRegistry: "registry read",
    compute_state_signature: "state signature for the dispatch's tags (computed per call)",
  };
  const NOT_A_DISPATCH: Array<{ fn: string; shape: string; why: string }> = [
    { fn: "let expWatchdogGapOpen", shape: "substrateGap_write", why: "the expectation watchdog's timer" },
  ];
  const DEBT: Array<{ fn: string; shape: string; why: string }> = [];
  const GUARD_WINDOW = 20_000;
  /** The end of the call whose "(" follows `at` (strings, template literals and ${} expressions are skipped). */
  const callEnd = (text: string, at: number): number => {
    const stack: string[] = [];
    let depth = 0;
    for (let j = text.indexOf("(", at); j >= 0 && j < text.length; j++) {
      const c = text[j]!;
      const mode = stack[stack.length - 1] ?? "code";
      if (mode === "code" || mode === "expr" || mode === "brace") {
        if (c === '"' || c === "'" || c === "`") stack.push(c);
        else if (mode === "code" && c === "(") depth++;
        else if (mode === "code" && c === ")") { if (--depth === 0) return j + 1; }
        else if (mode !== "code" && c === "{") stack.push("brace");
        else if (mode !== "code" && c === "}") stack.pop();
      } else if (c === "\\") j++;
      else if (c === mode) stack.pop();
      else if (mode === "`" && c === "$" && text[j + 1] === "{") { stack.push("expr"); j++; }
    }
    return text.length;
  };
  /** The shape a send writes or reads: the first type literal INSIDE the fetch call, else the one in the declaration (in
   *  the same function, before the send) of what its `body` names — the identifier itself, or the latest-declared
   *  identifier inside its JSON.stringify(...). Never a literal that merely follows the send. */
  const shapeOf = (text: string, fs: number, at: number): string | null => {
    const call = text.slice(at, callEnd(text, at));
    const inCall = /type:\s*"([^"]+)"/.exec(call);
    if (inCall) return inCall[1]!;
    const fnText = text.slice(fs, at);
    const declOf = (id: string): number => {
      const ds = [...fnText.matchAll(new RegExp(`\\b(?:const|let)\\s+${id}\\b[^=]*=`, "g"))];
      return ds.length > 0 ? ds[ds.length - 1]!.index ?? -1 : -1;
    };
    const named = /\bbody(?:\s*:\s*([A-Za-z_$][\w$]*)|\s*[,}\n])/.exec(call);
    let ids: string[] = named ? [named[1] ?? "body"] : [];
    if (ids[0] === "JSON") ids = [...(/JSON\.stringify\(([^)]*)\)/.exec(call)?.[1] ?? "").matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]);
    const decl = ids.map(declOf).filter((i) => i >= 0).sort((a, b) => b - a)[0];
    if (decl === undefined) return null;
    return /type:\s*"([^"]+)"/.exec(fnText.slice(decl))?.[1] ?? null;
  };
  const scan = (text: string) => {
    const sendRe = /(?<![\w.])fetch\(\s*`\$\{(?:DEV_VESSEL_ENDPOINT|ACTIVITY_API_ENDPOINT|process\.env\.DEVELOPMENT_VESSEL_ENDPOINT[^}]*)\}\/v2\/impulses\/resolve`/g;
    const fnStarts = [...text.matchAll(/\n(?:export )?(?:async )?function |\n(?:const|let) \w+ = |\nserver = |\n[ \t]+const \w+ = async \(/g)].map((m) => (m.index ?? 0) + 1);
    const guards = [...text.matchAll(/observeSkips?\(/g)].map((m) => m.index ?? 0);
    const out: Array<{ line: number; shape: string | null; fn: string; ok: string | null }> = [];
    for (const m of text.matchAll(sendRe)) {
      const at = m.index ?? 0;
      const fs = fnStarts.filter((x) => x <= at).pop() ?? 0;
      const shape = shapeOf(text, fs, at);
      const fn = text.slice(fs, fs + 80).trimStart();
      const guarded = guards.some((g) => g >= fs && g < at && at - g <= GUARD_WINDOW);
      const ok = shape && READS[shape] ? `read: ${READS[shape]}`
        : guarded ? "observe-guarded"
        : [...NOT_A_DISPATCH, ...DEBT].find((e) => fn.startsWith(e.fn) && e.shape === shape)?.why ?? null;
      out.push({ line: text.slice(0, at).split("\n").length, shape, fn: fn.split("\n")[0]!, ok });
    }
    return out;
  };
  test("[MUST-FAIL] class detector: no unguarded direct write to dev-vessel or activity-api from index.ts", () => {
    const sites = scan(src);
    expect(sites.length).toBeGreaterThan(20);
    expect(sites.filter((s) => s.ok === null).map((s) => `${s.line} ${s.shape} in ${s.fn}`)).toEqual([]);
  });
  test("class detector control: it flags an unguarded write it has not been told about", () => {
    const probe = "\nasync function probeWriter(): Promise<void> {\n  await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, { method: \"POST\", body: JSON.stringify({ impulse: { type: \"activityVariant_write\" } }) });\n}\n";
    expect(scan(probe).map((s) => s.ok)).toEqual([null]);
    const guarded = probe.replace("{\n  await", "{\n  if (observeSkip(\"authoring_mint\")) return;\n  await");
    expect(scan(guarded).map((s) => s.ok)).toEqual(["observe-guarded"]);
  });
  test("[MUST-FAIL] class detector: a write body built BEFORE the send is named by that body, not by a later read literal (qa case B)", () => {
    const probe = "\nasync function probeWriter(): Promise<void> {\n  const body = JSON.stringify({ impulse: { pointer: { type: \"activityVariant_write\" } } });\n  await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, { method: \"POST\", body });\n  const n = { type: \"memoryNote\" };\n}\n";
    expect(scan(probe).map((s) => [s.shape, s.ok])).toEqual([["activityVariant_write", null]]);
    const named = probe.replace("const body =", "const payload =").replace("body });", "body: payload });");
    expect(scan(named).map((s) => [s.shape, s.ok])).toEqual([["activityVariant_write", null]]);
    // a read built the same way is still a read, and every index.ts site resolves to a shape
    expect(scan(probe.replace("activityVariant_write", "memoryNote")).map((s) => s.ok)).toEqual(["read: memory read"]);
    expect(scan(src).filter((s) => s.shape === null)).toEqual([]);
  });
  test("composite-authoring.ts sends only through the door (or a caller's fetchImpl)", () => {
    const ca_src = require("node:fs").readFileSync(`${import.meta.dir}/../src/composite-authoring.ts`, "utf8") as string;
    expect(ca_src).toContain("deps.fetchImpl ?? ((url, init) => walkEgressFetch(shape, url, init))");
    // the one direct send left is A2's describeMintedShape (discovery's learned descriptions), which runs only after a
    // composite this walk minted RAN: unreachable under observe, where authorComposite is refused at the door
    const direct = [...ca_src.matchAll(/deps\.fetchImpl \?\? fetch\b/g)].map((m) => ca_src.lastIndexOf("export async function ", m.index ?? 0));
    expect(direct.map((i) => ca_src.slice(i, i + 48))).toEqual(["export async function describeMintedShape(discov"]);
    for (const s of ["author_producer", "author_composed_capability", "activityTemplate_deprecate"]) expect(ca_src).toContain(`sendFor("${s}", deps)`);
  });
});

describe("commit 11: the verdict-corpus and foreign-gate gaps are not filed by an observe dispatch, and do not latch", () => {
  const MOMENT = Date.parse("2026-10-12T12:00:00Z");
  test("[MUST-FAIL] credit hold: a hook that did not report (observe) leaves the once-latch open; the next read reports", () => {
    const calls: string[] = [];
    let t = MOMENT; let observe = true;
    configureCreditHold({ reader: () => null, clock: () => t, onUnavailable: (why) => { if (observe) return false; calls.push(why); } });
    heldFor(["floor:zero-tool"], "reach", "t"); // observe: not reported
    observe = false; t += HOLD_CACHE_TTL_MS + 1;
    heldFor(["floor:zero-tool"], "reach", "t"); // learn: reported now
    expect(calls.length).toBe(1);
  });
  test("control (learn): a hook that reports is still called once per loss", () => {
    const calls: string[] = [];
    let t = MOMENT;
    configureCreditHold({ reader: () => null, clock: () => t, onUnavailable: (why) => { calls.push(why); } });
    heldFor(["floor:zero-tool"], "reach", "t"); t += HOLD_CACHE_TTL_MS + 1; heldFor(["floor:zero-tool"], "reach", "t");
    expect(calls.length).toBe(1);
    configureCreditHold({ reader: readStatusSync, corpusDir: DEPLOYED_CORPUS_DIR, clock: () => Date.now(), onUnavailable: () => {} });
  });
  test("[MUST-FAIL] index.ts: the hook and fileVerdictCorpusGap skip under observe, the hook answering false", () => {
    expect(fnBody("  onUnavailable: (why, holds) => {", 400)).toContain('if (observeSkip("gap_write")) return false;');
    expect(fnBody("async function fileVerdictCorpusGap(", 300)).toContain('if (observeSkip("gap_write")) return;');
  });
  const gateHarness = (skip: () => boolean) => {
    const gaps: unknown[] = []; const logs: string[] = [];
    const gate = makeForeignConsumptionGate({ lib: {}, log: (l) => logs.push(l), writeGap: (g) => { gaps.push(g); }, skipReport: skip } as any);
    const trace = { id: "e", templateId: "t", status: "completed", inputImpulseIds: [], outputImpulseIds: [], tasks: [] } as any;
    return { gate, gaps, logs, trace };
  };
  test("[MUST-FAIL] foreign gate: an observe dispatch files no gap and does not set the once-flag; a later learn one files it", () => {
    let observe = true;
    const h = gateHarness(() => observe);
    h.gate.check(h.trace, { strict: true });
    expect(h.gaps).toEqual([]);
    observe = false;
    h.gate.check(h.trace, { strict: true });
    h.gate.check(h.trace, { strict: true });
    expect(h.gaps.length).toBe(1);
    expect(src).toContain('skipReport: () => observeSkip("gap_write"),');
  });
  test("control (learn): the gap is still filed exactly once per process", () => {
    const h = gateHarness(() => false);
    for (let i = 0; i < 3; i++) h.gate.check(h.trace, { strict: true });
    expect(h.gaps.length).toBe(1);
  });
});
