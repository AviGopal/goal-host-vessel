// JUDGE CONSISTENCY (src/judge/verdict-consistency.ts): the same answer to the same goal gets the same verdict, and a
// judge that disagrees with itself is resolved by a k-sample majority that then holds for the key.
// MUST-FAIL on the parent (d124f2f): the module does not exist and the reach gate checks nothing.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vc from "../../src/judge/verdict-consistency";

const SRC = (p: string) => readFileSync(join(import.meta.dir, "..", "..", "src", p), "utf8");

/** An in-memory store that counts reads and bytes, so a lookup's cost is measurable. */
function memStore() {
  const files = new Map<string, string>();
  const stats = { reads: 0, bytes: 0 };
  const io: vc.ConsistencyStoreIO = {
    async read(p) { stats.reads++; const v = files.get(p) ?? null; if (v) stats.bytes += v.length; return v; },
    async write(p, b) { files.set(p, b); },
    async list(d) { return [...files.keys()].filter((k) => k.startsWith(d + "/") && !k.slice(d.length + 1).includes("/")).map((k) => k.slice(d.length + 1)); },
  };
  return { files, stats, io };
}
const DIR = "/scratch/verdict-consistency";
const T0 = new Date("2026-10-17T12:00:00Z");
function deps(store: ReturnType<typeof memStore>, samples: Array<{ reached: boolean } | null> = [], cases: vc.DisagreementCase[] = []): vc.ReconcileDeps {
  let i = 0;
  return { dir: DIR, store: store.io, now: () => T0, sample: async () => samples[i++] ?? null, recordDisagreement: async (c) => { cases.push(c); } };
}
const GOAL = "Report how many open gaps the store holds right now.";
const ANSWER_1 = "There are **17** open gaps.\n(checked at 2026-10-17T09:00:00Z by exec_a1b2c3d4)";
const ANSWER_2 = "there are 17   open gaps.\n(checked at 2026-10-17T11:45:10.123Z by exec_ffee9988)"; // the SAME answer, another attempt context
const input = (answer: string, reached: boolean, over: Partial<Parameters<typeof vc.reconcileVerdict>[0]> = {}) => ({
  goalHash: "gh1", digest: vc.answerDigest(answer, ["shellResult"]), goal: GOAL, answer, producedShapes: ["shellResult"],
  verdict: { reached, reason: reached ? "The count is reported." : "The count is not grounded." }, k: 3, ttlMs: 604_800_000, ...over,
});

describe("the same answer under two attempt contexts gets the same verdict", () => {
  test("[MUST-FAIL] two attempt contexts of one answer share ONE key (timestamps, exec ids, case, markdown, spacing are not the answer)", () => {
    expect(vc.answerDigest(ANSWER_1, ["shellResult"])).toBe(vc.answerDigest(ANSWER_2, ["shellResult"]));
  });
  test("[MUST-FAIL] a disagreement is resolved by a k-sample majority, recorded as a case, and the majority then HOLDS for the key", async () => {
    const s = memStore(); const cases: vc.DisagreementCase[] = [];
    expect((await vc.reconcileVerdict(input(ANSWER_1, true), deps(s))).outcome).toBe("first");
    const r = await vc.reconcileVerdict(input(ANSWER_2, false), deps(s, [{ reached: true }], cases));
    expect(r.outcome).toBe("disagree_resolved");
    expect(r.reached).toBe(true); // stored reached + sample reached outvote the dissent
    expect(r.reason).toMatch(/verdict-consistency: the judge disagreed with its own earlier verdict/);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ goal_hash: "gh1", majority: "reached", k: 3, current: { reached: false } });
    const held = await vc.reconcileVerdict(input(ANSWER_2, false), deps(s));
    expect(held).toMatchObject({ outcome: "held_majority", reached: true });
    const rec = JSON.parse([...s.files.values()][0]!) as vc.ConsistencyRecord;
    expect(rec.majority).toMatchObject({ verdict: "reached", k: 3, votes: { reached: 2, not_reached: 1 } });
  });
  test("[MUST-FAIL] an agreeing verdict is counted, not re-sampled", async () => {
    const s = memStore(); let sampled = 0;
    await vc.reconcileVerdict(input(ANSWER_1, false), deps(s));
    const r = await vc.reconcileVerdict(input(ANSWER_2, false), { ...deps(s), sample: async () => { sampled++; return { reached: true }; } });
    expect(r.outcome).toBe("agree");
    expect(sampled).toBe(0);
    expect((JSON.parse([...s.files.values()][0]!) as vc.ConsistencyRecord).n).toBe(2);
  });
  test("a tie (the judge never answers the extra samples) resolves NOT reached: fail toward honest", async () => {
    const s = memStore();
    await vc.reconcileVerdict(input(ANSWER_1, true), deps(s));
    const r = await vc.reconcileVerdict(input(ANSWER_2, false), deps(s, [null, null]));
    expect(r).toMatchObject({ outcome: "disagree_resolved", reached: false });
  });
});

describe("PARAPHRASE (surface) and CONTROL", () => {
  test("[MUST-FAIL] a surface rewording (case, markdown emphasis, line breaks) is the same key and keeps the verdict", async () => {
    const s = memStore();
    await vc.reconcileVerdict(input("The build **passed**: 0 failures.", true), deps(s));
    const r = await vc.reconcileVerdict(input("the build passed:\n0   failures.", true), deps(s));
    expect(r.outcome).toBe("agree");
  });
  test("[CONTROL] a genuinely different answer is a different key and may get a different verdict", async () => {
    const s = memStore();
    await vc.reconcileVerdict(input("There are 17 open gaps.", true), deps(s));
    const r = await vc.reconcileVerdict(input("There are 18 open gaps.", false), deps(s));
    expect(r).toMatchObject({ outcome: "first", reached: false });
    expect(vc.answerDigest("There are 17 open gaps.")).not.toBe(vc.answerDigest("There are 18 open gaps."));
    expect(vc.answerDigest("same text", ["a"])).not.toBe(vc.answerDigest("same text", ["b"])); // produced shapes are part of the answer
  });
  test("[CONTROL] an expired reference is a fresh first sight", async () => {
    const s = memStore();
    await vc.reconcileVerdict(input(ANSWER_1, true), deps(s));
    const later = { ...deps(s), now: () => new Date(T0.getTime() + 604_800_001) };
    expect((await vc.reconcileVerdict(input(ANSWER_2, false), later)).outcome).toBe("first");
  });
});

describe("SCALE: one keyed read per lookup, whatever the store holds", () => {
  test("[MUST-FAIL] read count and bytes per lookup are the same with 1x and 10x stored keys", async () => {
    const cost = async (keys: number) => {
      const s = memStore();
      for (let i = 0; i < keys; i++) await vc.reconcileVerdict(input(`answer number ${i}`, true, { goalHash: `g${i % 7}` }), deps(s));
      await vc.reconcileVerdict(input(ANSWER_1, true), deps(s));
      const before = { ...s.stats };
      await vc.reconcileVerdict(input(ANSWER_2, true), deps(s));
      return { reads: s.stats.reads - before.reads, bytes: s.stats.bytes - before.bytes };
    };
    const one = await cost(50), ten = await cost(500);
    expect(one.reads).toBe(1);
    expect(ten).toEqual(one);
  });
});

describe("the store never writes live state under test, and the system can read it", () => {
  test("[MUST-FAIL] (1) with no root set (any importer that is not the service: this test), there is NO store and the gate skips", () => {
    vc.setVerdictConsistencyRootForTest(null);
    expect(vc.consistencyDir()).toBeNull();
    const idx = SRC("index.ts");
    const helper = idx.slice(idx.indexOf("async function reconcileVerdictConsistency("));
    expect(helper.slice(0, 1200)).toContain("if (!_dir) return;");
  });
  test("[MUST-FAIL] (2) the test seam sets a SCRATCH root (writes land under tmp) and refuses any other root", async () => {
    expect(() => vc.setVerdictConsistencyRootForTest("/workspace")).toThrow(/refused/);
    expect(() => vc.setVerdictConsistencyRootForTest("/workspace/git/super-repo")).toThrow(/refused/);
    const tmp = mkdtempSync(join(tmpdir(), "vc-"));
    try {
      vc.setVerdictConsistencyRootForTest(tmp);
      const dir = vc.consistencyDir()!;
      expect(dir).toBe(join(tmp, "state", "verdict-consistency"));
      const inp = input(ANSWER_1, true);
      await vc.reconcileVerdict(inp, { ...deps(memStore()), dir, store: vc.fsStore });
      expect(readFileSync(vc.recordPath(dir, inp.goalHash, inp.digest), "utf8")).toContain("verdict");
    } finally { vc.setVerdictConsistencyRootForTest(null); rmSync(tmp, { recursive: true, force: true }); }
  });
  test("[MUST-FAIL] the LIVE root is set only by the service boot (inside goal-host's import.meta.main block), with no env read", () => {
    const idx = SRC("index.ts");
    const boot = idx.indexOf("if (import.meta.main) {");
    const serve = idx.indexOf("server = Bun.serve(", boot);
    const set = idx.indexOf("verdictConsistency.setVerdictConsistencyRoot(dirname(DISPATCH_STORE_PATH));");
    expect(boot).toBeGreaterThan(0);
    expect(set).toBeGreaterThan(boot);
    expect(set).toBeLessThan(serve);
    expect(idx.match(/setVerdictConsistencyRoot\(/g)?.length).toBe(1);
    expect(SRC("judge/verdict-consistency.ts")).not.toMatch(/process\.env/);
  });
  test("[MUST-FAIL] the verdictConsistency read returns a goal's records (or one key), and refuses an unsafe or missing key", async () => {
    const s = memStore();
    await vc.reconcileVerdict(input(ANSWER_1, true), deps(s));
    const all = await vc.readVerdictConsistency({ goal_hash: "gh1" }, DIR, s.io);
    expect("records" in all && all.records).toHaveLength(1);
    expect("records" in all && all.records[0]).toMatchObject({ verdict: "reached", n: 1, digest: vc.answerDigest(ANSWER_1, ["shellResult"]) });
    expect(await vc.readVerdictConsistency({}, DIR, s.io)).toEqual({ error: "goal_hash is required" });
    expect(() => vc.recordPath(DIR, "../etc", "x")).toThrow(/unsafe/);
  });
  test("the gap seed is the system's (source substrate_detected), never an operator's", () => {
    const seed = vc.disagreementGapSeed({ goal_hash: "gh1", digest: "d1", goal: GOAL, answer_excerpt: "a", produced_shapes: [], prior: { verdict: "reached", reason_code: null, n: 1, first_at: "", last_at: "" }, current: { reached: false, reason: null }, samples: [], majority: "reached", k: 3, at: "" });
    expect(seed).toMatchObject({ source: "substrate_detected", status: "open", category: "systematic_failure" });
    expect(String(seed["id"])).toBe("reach-judge-disagreed-with-itself-gh1-d1");
  });
});

describe("[WIRING] the reach gate consults it, the system can see it, and the judge never learns from its own verdict", () => {
  const index = SRC("index.ts");
  test("inside verifyGoalReached, for a non-deterministic verdict, BEFORE the capture (so the capture records what is returned)", () => {
    const start = index.indexOf("async function verifyGoalReached(");
    const check = index.indexOf("if (v && !isDeterministicVerdict(v) && !v.abstain) await reconcileVerdictConsistency(v, goal, producedShapes, taskSummary, contentDigest, commandEvidence, deliverables ?? writeEvidence?.targets);", start);
    const capture = index.indexOf('judgeCapture.captureJudgeInput("reachGate"', start);
    const end = index.indexOf("async function verifyGoalReachedUnrestricted(", start);
    expect(start).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(start);
    expect(check).toBeLessThan(capture);
    expect(capture).toBeLessThan(end);
    const helper = index.indexOf("async function reconcileVerdictConsistency(");
    expect(helper).toBeGreaterThan(0);
    const body = index.slice(helper, start);
    expect(body).toContain("verdictConsistency.reconcileVerdict(");
    expect(body).toContain("k: _t.verdictConsistencyK, ttlMs: _t.verdictConsistencyTtlMs");
    expect(body).toContain('sample: (i) => llmJudgeReach(goal, producedShapes, taskSummary, contentDigest, commandEvidence, `${_gh}:consistency-${i}`),');
  });
  test("advertised and served as a read shape, and counted on /health", () => {
    expect(index).toMatch(/"verdictCorpusRun", "verdictConsistency"\] as const;/);
    expect(index).toContain('if (type === "verdictConsistency") {');
    expect(index).toContain("verdict_consistency: verdictConsistency.consistencyCounters(),");
  });
  test("k and TTL come from the shaped selection-tuning row, not a constant or env", () => {
    const st = SRC("selection-tuning.ts");
    expect(st).toContain('verdictConsistencyK: resolveField("verdictConsistencyK", parsed["verdictConsistencyK"]),');
    expect(st).toContain('verdictConsistencyTtlMs: resolveField("verdictConsistencyTtlMs", parsed["verdictConsistencyTtlMs"]),');
    expect(st).toMatch(/verdictConsistencyK: undefined,\n\s*verdictConsistencyTtlMs: undefined,/);
  });
  test("(c) the reach-verification route is never rewarded by the dispatch's own verdict (llm-router flushRouterFeedback)", () => {
    const r = SRC("llm-router.ts");
    const f = r.indexOf("export async function flushRouterFeedback(");
    expect(f).toBeGreaterThan(0);
    expect(r.slice(f, f + 1600)).toContain('buf.filter((s) => s.taskType !== "reach_verification")');
  });
});
