// FAILURE RECALL IS AN ACTIVITY, AND ITS VARIANT-1 DROPS LEGACY CALLER-CUT LESSONS (USER: "Build the filter now").
//
// A compose cut at the caller used to be remembered as the attempt's own failure, and those records are still recalled
// into the synthesis and floor prompts (and, as an exact record, turn command replay off). A record has no field that
// tells such a lesson apart; only its reason text does, and that text is still written for a failure that was not a
// cut. So records now carry outcome_source, and variant-1 drops only records WITHOUT it whose reason has the cut text.
//   - [MUST-FAIL] the writers stamp outcome_source (graded, dispatch_error, unconfirmed, non_attempt).
//   - [MUST-FAIL] under variant-1 a legacy cut lesson is not recalled; a stamped record with the same text IS.
//   - [CONTROL] variant-0 (and any recall outside a dispatch) ignores outcome_source: a stamped and an unstamped record
//     give the same feedback text, and every record is recalled as before.
//   - the dispatch's decision: no mask (or an unreadable pool) is variant-0 and traces under the variant-0 id; a mask in
//     force selects variant-1; the credit is posted once, at a decided verdict, only when the clause matched a record,
//     under EITHER variant (the clause runs as a shadow under variant-0), so both arms of a comparison are graded.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFetch = globalThis.fetch;
const root = mkdtempSync(join(tmpdir(), "failure-recall-variant-"));
const prev = { mem: process.env["GOAL_FAILURE_MEMORY_PATH"], ws: process.env["WORKSPACE_ROOT"] };
process.env["GOAL_FAILURE_MEMORY_PATH"] = join(root, "failure-memory.jsonl");
process.env["WORKSPACE_ROOT"] = root;
process.env["LLM_VESSEL_ENDPOINT"] ??= "http://127.0.0.1:65535";
process.env["GOAL_HOST_DISPATCH_STORE_PATH"] = join(root, "dispatches.json");

let masks: Array<{ id?: string; body?: unknown }> | "down" = [];
const traces: Array<Record<string, unknown>> = [];
let G: Record<string, any> = {};
let FR: Record<string, any> = {};

beforeAll(async () => {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    const body = typeof init?.body === "string" ? init.body : "";
    if (u.includes("/v2/impulses/resolve") && body.includes('"activityVariantMask"')) {
      if (masks === "down") throw new TypeError("Unable to connect");
      return Response.json({ success: true, body: { impulses: masks } });
    }
    if (u.endsWith("/v2/activities/execution-traces")) { traces.push(JSON.parse(body)); return Response.json({ ok: true }, { status: 201 }); }
    return Response.json({ error: "stub: not served" }, { status: 404 });
  }) as unknown as typeof fetch;
  G = (await import("../src/index")) as Record<string, any>;
  FR = (await import("../src/failure-recall")) as Record<string, any>;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of [["GOAL_FAILURE_MEMORY_PATH", prev.mem], ["WORKSPACE_ROOT", prev.ws]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

const CUT = "early edit-intent routed to feature_compose; stage=unknown (caller cut at 1028s, no report) - the check_supply compose call failed or was refused and nothing landed for gap-x - a check-supply goal is never walked or escalated";
const GRADED = "deterministic:no-artifact the compose produced no file";
let seq = 0;
const goalOf = (tag: string) => `failure recall fixture ${tag} ${++seq}`;
const inDispatch = <T>(variant: number | undefined, fn: () => T): T => G.dispatchContext.run({ dispatchId: `d-${++seq}`, failureRecall: variant === undefined ? {} : { variant } }, fn);
const DAY = 86_400_000;
const mask = (active_variant: number) => [{ id: "mask-fr", body: { activity_id: "goal-host:failure-recall", active_variant, from: new Date(Date.now() - DAY).toISOString(), until: new Date(Date.now() + DAY).toISOString(), reason: "fixture", by: "operator" } }];

describe("the legacy caller-cut clause", () => {
  test("[MUST-FAIL] a record without outcome_source whose reason has the cut text is a legacy lesson; a stamped one never is", () => {
    expect(FR.legacyCallerCutLesson({ reason: CUT })).toBe(true);
    expect(FR.legacyCallerCutLesson({ reason: CUT, outcome_source: "dispatch_error" })).toBe(false);
    expect(FR.legacyCallerCutLesson({ reason: GRADED })).toBe(false);
  });
  test("the mask: no row, another activity's row, an out-of-window row, an unknown variant, an unread pool are all variant-0", () => {
    const at = new Date().toISOString();
    expect(FR.failureRecallVariant(at, []).variant).toBe(0);
    expect(FR.failureRecallVariant(at, null)).toMatchObject({ variant: 0, why: "mask_unread: variant-0" });
    expect(FR.failureRecallVariant(at, [{ id: "o", body: { ...mask(1)[0]!.body, activity_id: "development-vessel:reach-grade" } }]).variant).toBe(0);
    expect(FR.failureRecallVariant(at, [{ id: "w", body: { ...mask(1)[0]!.body, from: new Date(Date.now() + DAY).toISOString(), until: new Date(Date.now() + 2 * DAY).toISOString() } }]).variant).toBe(0);
    expect(FR.failureRecallVariant(at, mask(7)).variant).toBe(0);
    expect(FR.failureRecallVariant(at, mask(1)).variant).toBe(1);
  });
});

describe("the writers stamp outcome_source", () => {
  test("[MUST-FAIL] graded, dispatch_error, unconfirmed and non_attempt records carry their source", () => {
    const g = goalOf("stamps");
    G.rememberDispatchFailures(g, [], `${GRADED} graded`, "p", [], 1);
    G.rememberDispatchFailures(g, [], `${GRADED} threw`, "p", [], 1, "dispatch_error");
    G.rememberUnconfirmedDispatchFailures(g, [], `${GRADED} cut`, "p", [], 1);
    G.rememberUnconfirmedDispatchFailures(g, [], `${GRADED} non-attempt`, "p", [], 1, "a non-attempt", "non_attempt");
    const bySuffix = Object.fromEntries((G.recallGoalFailures(g).exact as Array<{ reason: string; outcome_source?: string }>).map((r) => [r.reason.split(" ").pop(), r.outcome_source]));
    expect(bySuffix).toEqual({ graded: "graded", threw: "dispatch_error", cut: "unconfirmed", "non-attempt": "non_attempt" });
  });
});

describe("recall by variant", () => {
  test("[CONTROL] variant-0 and recall outside a dispatch ignore outcome_source: same records, same feedback text", () => {
    const a = goalOf("v0-unstamped"), b = goalOf("v0-stamped");
    G.rememberGoalFailure(a, CUT, "feature_compose", ["fileEditResult"], 1);
    G.rememberGoalFailure(b, CUT, "feature_compose", ["fileEditResult"], 1, undefined, "dispatch_error");
    for (const v of [undefined, 0]) {
      const ra = inDispatch(v, () => G.recallGoalFailures(a));
      const rb = inDispatch(v, () => G.recallGoalFailures(b));
      expect(ra.exact.map((r: { reason: string }) => r.reason)).toEqual([CUT]);
      expect(rb.exact.map((r: { reason: string }) => r.reason)).toEqual([CUT]);
      expect(FR.failureFeedbackText(ra.exact, ra.near).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "T")).toBe(FR.failureFeedbackText(rb.exact, rb.near).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "T"));
    }
    expect(G.recallGoalFailures(a).exact.length).toBe(1);
  });
  test("[MUST-FAIL] under variant-1 a legacy cut lesson is not recalled; a stamped record with the same text, and a graded one, are", () => {
    const g = goalOf("v1");
    G.rememberGoalFailure(g, CUT, "feature_compose", ["fileEditResult"], 1);
    G.rememberGoalFailure(g, `${CUT} (stamped)`, "feature_compose", ["fileEditResult"], 1, undefined, "dispatch_error");
    G.rememberGoalFailure(g, GRADED, "p", [], 1, undefined, "graded");
    const r = inDispatch(1, () => G.recallGoalFailures(g));
    expect(r.exact.map((x: { reason: string }) => x.reason).sort()).toEqual([`${CUT} (stamped)`, GRADED].sort());
  });
});

describe("the dispatch's decision, trace and credit", () => {
  const decide = async (g: string, store: Record<string, any>) => G.dispatchContext.run(store, () => G.decideFailureRecall(g, "/test"));
  test("no mask in force: variant-0, traced under the variant-0 id, with what variant-1 would have filtered", async () => {
    const g = goalOf("decide-v0");
    G.rememberGoalFailure(g, CUT, "feature_compose", ["fileEditResult"], 1);
    masks = []; traces.length = 0;
    const store: Record<string, any> = { dispatchId: "d-v0", failureRecall: {} };
    await decide(g, store);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.failureRecall).toMatchObject({ variant: 0, matched: 1 });
    expect(traces.length).toBe(1);
    expect(traces[0]!["activity_variant_id"]).toBe("goal-host:failure-recall");
    expect((traces[0]!["metadata"] as any).failureRecall).toMatchObject({ exact_before: 1, exact_after: 1, filtered: 0, would_filter: 1, reuse_enabled_by_filter: false });
    expect(G.dispatchContext.run(store, () => G.recallGoalFailures(g)).exact.length).toBe(1);
  });
  test("an unreadable pool is variant-0", async () => {
    const g = goalOf("decide-down");
    G.rememberGoalFailure(g, CUT, "feature_compose", ["fileEditResult"], 1);
    masks = "down";
    const store: Record<string, any> = { dispatchId: "d-down", failureRecall: {} };
    await decide(g, store);
    expect(store.failureRecall).toMatchObject({ variant: 0, why: "mask_unread: variant-0" });
  });
  test("[MUST-FAIL] a mask in force selects variant-1: the legacy lesson is filtered, replay is re-enabled, and the credit grades the dispatch's decided verdict once", async () => {
    const g = goalOf("decide-v1");
    G.rememberGoalFailure(g, CUT, "feature_compose", ["fileEditResult"], 1);
    masks = mask(1); traces.length = 0;
    const store: Record<string, any> = { dispatchId: "d-v1", failureRecall: {} };
    await decide(g, store);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.failureRecall).toMatchObject({ variant: 1, matched: 1 });
    expect((traces[0]!["metadata"] as any).failureRecall).toMatchObject({ exact_before: 1, exact_after: 0, filtered: 1, reuse_enabled_by_filter: true });
    expect(traces[0]!["activity_variant_id"]).toBe("goal-host:failure-recall-v1");
    expect(G.dispatchContext.run(store, () => G.recallGoalFailures(g)).exact.length).toBe(0);
    G.dispatchContext.run(store, () => G.creditFailureRecall(true, true));
    G.dispatchContext.run(store, () => G.creditFailureRecall(false, true));
    await new Promise((r) => setTimeout(r, 20));
    const credits = traces.filter((t) => t["activity_id"] === "goal-host:failure-recall-credit");
    expect(credits.length).toBe(1);
    expect(credits[0]!["composition_chain"]).toEqual([traces[0]!["execution_id"]]);
    expect(credits[0]!["tags"]).toContain("reached:true");
  });
  test("[MUST-FAIL] the control arm is graded too: a variant-0 dispatch whose recall the clause matched posts exactly one credit, tagged variant 0 (red if the credit gate ever checks the variant)", async () => {
    const g = goalOf("credit-v0");
    G.rememberGoalFailure(g, CUT, "feature_compose", ["fileEditResult"], 1);
    masks = []; traces.length = 0;
    const store: Record<string, any> = { dispatchId: "d-credit-v0", failureRecall: {} };
    await decide(g, store);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.failureRecall).toMatchObject({ variant: 0, matched: 1 });
    G.dispatchContext.run(store, () => G.creditFailureRecall(false, true));
    G.dispatchContext.run(store, () => G.creditFailureRecall(true, true));
    await new Promise((r) => setTimeout(r, 20));
    const credits = traces.filter((t) => t["activity_id"] === "goal-host:failure-recall-credit");
    expect(credits.length).toBe(1);
    expect(credits[0]!["tags"]).toEqual(["reached:false", "failure_recall_variant:0"]);
    expect(credits[0]!["composition_chain"]).toEqual([traces.find((t) => t["activity_variant_id"] === "goal-host:failure-recall")!["execution_id"]]);
  });
  test("[CONTROL] no credit when nothing matched, or when the verdict is not decided", async () => {
    const g = goalOf("credit-none");
    G.rememberGoalFailure(g, GRADED, "p", [], 1, undefined, "graded");
    masks = mask(1); traces.length = 0;
    const plain: Record<string, any> = { dispatchId: "d-plain", failureRecall: {} };
    await decide(g, plain);
    G.dispatchContext.run(plain, () => G.creditFailureRecall(true, true));
    const g2 = goalOf("credit-undecided");
    G.rememberGoalFailure(g2, CUT, "feature_compose", ["fileEditResult"], 1);
    const undecided: Record<string, any> = { dispatchId: "d-undecided", failureRecall: {} };
    await decide(g2, undecided);
    G.dispatchContext.run(undecided, () => G.creditFailureRecall(false, false));
    await new Promise((r) => setTimeout(r, 20));
    expect(traces.filter((t) => t["activity_id"] === "goal-host:failure-recall-credit").length).toBe(0);
  });
  test("[CONTROL] a store with no root record recalls as variant-0 and traces nothing", async () => {
    const g = goalOf("no-root");
    G.rememberGoalFailure(g, CUT, "feature_compose", ["fileEditResult"], 1);
    masks = mask(1); traces.length = 0;
    const store: Record<string, any> = { dispatchId: "d-noroot" };
    await decide(g, store);
    expect(traces.length).toBe(0);
    expect(G.dispatchContext.run(store, () => G.recallGoalFailures(g)).exact.length).toBe(1);
  });
});
