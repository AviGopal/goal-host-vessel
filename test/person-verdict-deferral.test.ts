// A JUDGE-ONLY REACH IS GRADED BY A PERSON'S VERDICT (USER ruling 2026-10-29T22:38:47Z, "Person verdict counts").
//
// A reach the LLM judge alone called reached (non-deterministic, alpha withheld for no in-chain edge) is not graded at
// walk end: its walk-complete /reach is deferred and the record carries the deferral (reach_decided_by:person). A
// PERSON's label then sends the same /reach (achieved -> alpha + mint; not_achieved -> beta, no mint). An operator key's
// verdict:human row and an agent's automated row decide nothing. A deferral is retention-protected while open and
// resolves ungraded-expired (no /reach) after the shaped window personVerdictWindowMs (default 7 days).
//
//   [MUST-FAIL] a judge-only reach is NOT graded at walk end (deferred; wiring and decision)
//   [CONTROL]   deterministic and reached=false walks ARE graded at walk end; the throw path is unchanged
//   [MUST-FAIL] a deferred row is retention-protected, and expires (ungraded, no /reach) after the window
//   [MUST-FAIL] a person "reached" credits and mints; a person "not reached" debits with no mint
//   [MUST-FAIL] an operator-key verdict:human row does nothing on a deferred row (no decision, no latch)
//   [CONTROL]   an agent's automated row does nothing; a second person label is a no-op
//   [CONTROL]   a judge-only reach does not mint at walk time (groundedForMint unchanged)
//   [CONTROL]   a non-deferred record keeps the existing human override (no posterior write)
//   [CONTROL]   an OBSERVE dispatch's deferral resolves ungraded: a person verdict never grades it
//
// Fixture from a fresh 5-word draw (draw-words.sh):
//   2026-10-29T23:17:50Z seed=1793315870872284906 words=absinthe trustable mashed snowman saturate
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as consumer from "../src/oracle-label-consumer";
import { consumeOracleLabel, type OracleLabelRecord } from "../src/oracle-label-consumer";
import { groundedForMint } from "../src/applied-write";
import { SELECTION_TUNING_DEFAULTS } from "../src/selection-tuning";

const PV = (await import("../src/person-verdict").catch(() => ({}))) as Record<string, any>;
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

const ACT = "http://act.test";
const DEV = "http://dev.test";
const EXEC = "walk-satisfier-1-1793315870";
const NOW = Date.parse("2026-10-29T23:20:00.000Z");
const DAY = 86_400_000;

function stubFetch(rows: unknown[]) {
  const impl = (async (input: any) => {
    const url = String(input);
    if (url.startsWith(ACT)) return new Response(JSON.stringify({ success: true, content: JSON.stringify(rows) }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return impl;
}
type Decision = { deliver: boolean; reached: boolean | null; mint: boolean };
function deferredRecord(): OracleLabelRecord & { deferredReach?: any; reachDecidedBy?: string } {
  return {
    status: "completed", executionId: EXEC, goal: "Is a trustable snowman mashed by absinthe-saturated snow?", reached: true,
    goalReachReason: "judge: the answer addresses the question", learning: { oracleLabelWritten: false },
    deferredReach: { executionId: EXEC, completionShapes: ["llm_completion_dispatch"], reason: "judge: the answer addresses the question", goalHash: "g1", betaWithheldReason: null, deferredAt: NOW, state: "open" },
  };
}
function deps(rows: unknown[], decided: Decision[]) {
  return { activityApiEndpoint: ACT, devVesselEndpoint: DEV, apiKey: "", fetchImpl: stubFetch(rows), decideDeferredReach: async (_r: unknown, d: Decision) => { decided.push(d); } } as any;
}
const personStamp = { user_id: "person-1", caller_type: "session", actor_key_id: "key-surface", aud: "node-a/goal_verification_label_write", auth_type: "jwt", scopes: ["read", "write"] };
const person = (verdict: string) => ({ verdict, labeler: "human", notes: "person verdict", labeled_by_principal: personStamp });
const operatorKey = { verdict: "achieved", labeler: "human", notes: "operator", labeled_by_principal: { key_id: "key-verdict", auth_type: "apikey", scopes: ["read", "write", "verdict:human"] } };
const automated = { verdict: "achieved", labeler: "automated", notes: "agent provide_feedback" };

beforeEach(() => { consumer.__resetOracleLabelCountersForTests(); });

describe("the walk end: a judge-only reach waits for a person", () => {
  it("[MUST-FAIL] a judge-only reach is deferred, not graded at walk end", () => {
    expect(PV["isJudgeOnlyReach"]?.(true, "judge: satisfied", "no-in-chain-edge")).toBe(true);
    const at = SRC.indexOf("if (record.executionId && isJudgeOnlyReach(record.reached, seek.goalReachReason, alphaWithheld.get(record.executionId))) {");
    const walkEnd = SRC.indexOf('deliverReachVerdict(record.executionId, record.reached, seek.completionShapes, "walk-complete"');
    expect(at).toBeGreaterThan(0);
    expect(walkEnd).toBeGreaterThan(at);
    expect(SRC.slice(at, walkEnd)).toContain('record.reachDecidedBy = "person";');
    expect(SRC.slice(at, walkEnd)).toContain("} else {");
    // the walk records the alpha withhold that marks the reach judge-only
    expect(SRC).toContain('walkAlphaWithheldNoEdge = true; if (lastTrace?.id) opts.alphaWithheld?.set(lastTrace.id, ALPHA_WITHHELD_NO_EDGE);');
    // and its durable satisfier trace is not graded at insert (no reached:true tag): the person's /reach is its first grading
    expect(SRC).toContain('if (reached && walkAlphaWithheldNoEdge && isJudgeOnlyReach(true, goalReachReason, ALPHA_WITHHELD_NO_EDGE)) durableTrace.tags = _existingTags;');
    // the walk-end deferral captures the dispatch's learning mode, and the person's delivery re-enters that dispatch with it
    expect(SRC).toContain("learningMode: learningMode ?? null }, Date.now());");
    expect(SRC).toContain("dispatchContext.run(enterDispatchContext(undefined, { dispatchId: record.dispatchId, learningMode: d.learningMode ?? undefined }), async () => {");
  });

  it("[CONTROL] deterministic, reached=false and alpha-credited walks are graded at walk end; the throw path is unchanged", () => {
    const j = PV["isJudgeOnlyReach"] ?? (() => false);
    expect(j(true, "deterministic:landed-sha", "no-in-chain-edge")).toBe(false);
    expect(j(false, "judge: not satisfied", "no-in-chain-edge")).toBe(false);
    expect(j(true, "judge: satisfied", undefined)).toBe(false);
    expect(SRC).toContain('if (!__isPinnedRefusal) deliverReachVerdict(record.executionId, false, (record as { completionShapes?: string[] | null }).completionShapes ?? [], "walk-threw", record.error, goalHashOf(String(goal ?? "")), betaWithheld);');
  });
});

describe("retention and the window", () => {
  it("[MUST-FAIL] an open deferral is retention-protected and expires ungraded after the window", () => {
    const d = PV["openDeferral"]?.({ executionId: EXEC, completionShapes: [], reason: null, goalHash: null, betaWithheldReason: null }, NOW);
    expect(PV["retainsRecord"]?.(d)).toBe(true);
    expect(PV["deferralExpired"]?.(d, NOW + 7 * DAY - 1, 7 * DAY)).toBe(false);
    expect(PV["deferralExpired"]?.(d, NOW + 7 * DAY, 7 * DAY)).toBe(true);
    expect(PV["expireDeferral"]?.(d, NOW + 7 * DAY)).toBe(true);
    expect(d?.state).toBe("expired");
    expect(d?.decision).toBe("no person verdict");
    expect(PV["retainsRecord"]?.(d)).toBe(false);
    // the window is the shaped tuning row, default 7 days; pruneStore keeps an open deferral and runs the expiry
    expect((SELECTION_TUNING_DEFAULTS as Record<string, unknown>)["personVerdictWindowMs"]).toBe(7 * DAY);
    expect(SRC).toContain("if (retainsRecord(r.deferredReach)) continue;");
    expect(SRC).toContain("for (const [id, r] of byNewest.slice(2000)) if (!retainsRecord(r.deferredReach)) executionStore.delete(id);");
    expect(SRC).toContain("void expireDeferredReaches().catch(");
    // expiry posts no /reach
    const fn = SRC.slice(SRC.indexOf("async function expireDeferredReaches("), SRC.indexOf("function pruneStore(): void {"));
    expect(fn).not.toContain("deliverReachVerdict(");
  });
});

describe("a person's verdict decides a deferred reach", () => {
  it("[MUST-FAIL] person achieved: reached=true is delivered and minted", async () => {
    const rec = deferredRecord(); const decided: Decision[] = [];
    await consumeOracleLabel(rec, deps([person("achieved"), automated], decided));
    expect(decided).toEqual([{ deliver: true, reached: true, mint: true }]);
    expect(rec.deferredReach.state).toBe("delivered");
    expect(rec.reachDecidedBy).toBe("person");
    expect(rec.learning?.oracleLabelWritten).toBe(true);
    // the delivery is the walk's own /reach and the mint is grounded by the person
    const fn = SRC.slice(SRC.indexOf("async function decideDeferredReach("), SRC.indexOf("async function expireDeferredReaches("));
    expect(fn).toContain('deliverReachVerdict(d.executionId, decision.reached, d.completionShapes, "person-verdict", d.reason, d.goalHash, personBetaWithheld);');
    expect(fn).toContain("await mintReachedTrace(trace, true,");
  });

  it("[MUST-FAIL] person not achieved: reached=false is delivered, no mint", async () => {
    const rec = deferredRecord(); const decided: Decision[] = [];
    await consumeOracleLabel(rec, deps([person("not_achieved")], decided));
    expect(decided).toEqual([{ deliver: true, reached: false, mint: false }]);
    expect(rec.reached).toBe(false);
  });

  it("[MUST-FAIL] an operator-key verdict:human row does nothing on a deferred row", async () => {
    const rec = deferredRecord(); const decided: Decision[] = [];
    await consumeOracleLabel(rec, deps([operatorKey], decided));
    expect(decided).toEqual([]);
    expect(rec.deferredReach.state).toBe("open");
    expect(rec.learning?.oracleLabelWritten).toBe(false);
    expect(rec.reached).toBe(true);
  });

  it("[CONTROL] an agent's automated row does nothing", async () => {
    const rec = deferredRecord(); const decided: Decision[] = [];
    await consumeOracleLabel(rec, deps([automated], decided));
    expect(decided).toEqual([]);
    expect(rec.deferredReach.state).toBe("open");
    expect(rec.learning?.oracleLabelWritten).toBe(false);
  });

  it("[CONTROL] a second person label on the same execution is a no-op", async () => {
    const rec = deferredRecord(); const decided: Decision[] = [];
    await consumeOracleLabel(rec, deps([person("achieved")], decided));
    await consumeOracleLabel(rec, deps([person("not_achieved"), person("achieved")], decided));
    expect(decided).toEqual([{ deliver: true, reached: true, mint: true }]);
    expect(rec.reached).toBe(true);
  });

  it("[CONTROL] an OBSERVE dispatch's deferral resolves ungraded: a person verdict never grades it", async () => {
    const rec = deferredRecord(); rec.deferredReach.learningMode = "observe"; const decided: Decision[] = [];
    await consumeOracleLabel(rec, deps([person("achieved")], decided));
    expect(decided).toEqual([{ deliver: false, reached: true, mint: false }]);
    expect(rec.deferredReach.state).toBe("ungraded");
    // and the delivery path itself refuses a non-deliver decision before any /reach or mint
    const fn = SRC.slice(SRC.indexOf("async function decideDeferredReach("), SRC.indexOf("async function expireDeferredReaches("));
    expect(fn).toContain('if (!d || !decision.deliver || typeof decision.reached !== "boolean") { persistDispatchStore(); return; }');
  });

  it("[CONTROL] a person's partial verdict resolves the deferral ungraded (no alpha, no beta)", async () => {
    const rec = deferredRecord(); const decided: Decision[] = [];
    await consumeOracleLabel(rec, deps([person("partial")], decided));
    expect(decided).toEqual([{ deliver: false, reached: null, mint: false }]);
    expect(rec.deferredReach.state).toBe("ungraded");
  });
});

describe("[CONTROL] the person's /reach runs in the record's own dispatch, never an ambient one", () => {
  it("delivered while an unrelated dispatch's store is ambient: the record's dispatchId, no foreign gap id, the deferral's own mode", async () => {
    process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
    const m = (await import("../src/index")) as Record<string, any>;
    const ctx = m["dispatchContext"] as { run: <T>(s: Record<string, unknown>, fn: () => T) => T; getStore: () => Record<string, unknown> | undefined };
    const seen: Array<{ url: string; store: Record<string, unknown> | undefined; body: any }> = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, init?: { body?: unknown }) => {
      let body: any = null; try { body = JSON.parse(String(init?.body ?? "null")); } catch { /* not JSON */ }
      seen.push({ url: String(u), store: ctx.getStore() ? { ...ctx.getStore() } : undefined, body });
      return new Response(JSON.stringify({ updated: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      const rec: any = { ...deferredRecord(), dispatchId: "own-dispatch" };
      rec.deferredReach.learningMode = "learn";
      await ctx.run({ dispatchId: "other", decomposeGapId: "X", learningMode: "observe" }, () => m["decideDeferredReach"](rec, { deliver: true, reached: false, mint: false }));
      await new Promise((r) => setTimeout(r, 30));
    } finally { globalThis.fetch = real; }
    const reach = seen.filter((c) => c.url.includes("/execution-traces/reach"));
    expect(reach.length).toBe(1);
    expect(reach[0]!.store?.["dispatchId"]).toBe("own-dispatch");
    expect(reach[0]!.store?.["decomposeGapId"]).toBeUndefined();
    expect(reach[0]!.store?.["learningMode"]).toBe("learn");
    expect(reach[0]!.body?.learning_mode).toBe("learn");
    expect(reach[0]!.body?.execution_id).toBe(EXEC);
    expect(reach[0]!.body?.reached).toBe(false);
  }, 30_000);
});

describe("[CONTROL] what is unchanged", () => {
  it("a judge-only reach does not mint at walk time: an ungrounded trace with no verified write is refused", () => {
    expect(groundedForMint(false, { tasks: [{ taskId: "satisfier-resolve", outputShapes: ["llm_completion_dispatch"], success: true } as any], metadata: {} })).toBe(false);
  });

  it("a non-deferred record keeps the existing human override, with no decision handed out", async () => {
    const rec: OracleLabelRecord = { status: "completed", executionId: "exec-plain", goal: "g", reached: true, goalReachReason: "judge", learning: { oracleLabelWritten: false } };
    const decided: Decision[] = [];
    await consumeOracleLabel(rec, deps([operatorKey, person("not_achieved")], decided));
    expect(decided).toEqual([]);
    expect(rec.learning?.oracleLabelWritten).toBe(true);
    expect(rec.reached).toBe(true); // operatorKey (newest) said achieved
  });
});
