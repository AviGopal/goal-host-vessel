// PROTECTED (MUST-FAILS): the runner's compare / classify logic and the corpus's power to see a defect.
//
// Each seed is seen RED under a mutant that reinstates the false positive it pins:
//   LOOSEN  = the open rules pass every write goal, the floor reaches on any upstream reach, every shortcut is
//             allowed, every re-frame accepted, and the closed zero-tool write-claim clamp is off;
//   TIGHTEN = every gate hollows, the floor never reaches, every shortcut refused, every re-frame rejected,
//             every hollow charged (it reddens the controls: an "always hollow" judge cannot pass the corpus).
// Every green case must be red under at least one of the two, or it pins nothing. Plus: nondeterminism, a
// fetch inside a replay, append-check, the ungated (no ever-green set) classification, the runner activity's
// fail-closed states, and no environment skip in any protected file.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendCheck, checkCase, canonicalJson, chainLink, classify, compare, GENESIS_LINK, holdsFrom, loadCorpus, replayCase, sha256Hex, type CorpusCase, type ReplayOverrides } from "./runner";
import { createRunAcceptor, dispositionFor, planGapWrite, routeGap, RUNNER_ID, runVerdictCorpusActivity, triggerOf, type CorpusGap, type GapRow } from "../../src/judge/corpus-activity";
import type { VerdictCorpusStatus } from "../../src/judge/credit-hold";

const DIR = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(DIR);
const byId = new Map(corpus.cases.map((c) => [c.id, c]));

const passV = { reached: true, hollow_class: null, reason_code: "write-goal-gate:pass", deterministic: false };
export const LOOSEN: ReplayOverrides = {
  zeroToolClaimOff: true,
  rules: {
    reachGate: () => passV,
    floorDecide: (i) => ({ reached: i.upstream?.reached === true, hollow_class: null, reason_code: i.upstream?.reached === true ? "floor:reached" : "floor:upstream-not-reached", deterministic: false, fabricated_transcript: false }),
    floorShortcutAllowed: () => ({ allowed: true, reason_code: "shortcut:own-pathway" }),
    reframeAccept: () => ({ accept: true, reason_code: "reframe:accepted" }),
  },
  credit: () => ({ alpha_reachable: false, charge: false, withheld: "alpha-unreachable-non-deterministic-no-edge", retire_candidate: false }),
};
export const TIGHTEN: ReplayOverrides = {
  rules: {
    reachGate: () => ({ reached: false, hollow_class: "write-goal-no-artifact", reason_code: "write-goal-no-artifact:change", deterministic: false }),
    floorDecide: () => ({ reached: false, hollow_class: "floor-no-substance", reason_code: "floor:no-substance", deterministic: false, fabricated_transcript: false }),
    floorShortcutAllowed: () => ({ allowed: false, reason_code: "shortcut:edit-goal" }),
    reframeAccept: () => ({ accept: false, reason_code: "reframe:punt-only" }),
  },
  credit: () => ({ alpha_reachable: true, charge: true, withheld: null, retire_candidate: false }),
};
/** The extreme loosening: the floor reaches whatever the upstream verdict said. */
export const ALWAYS_REACH: ReplayOverrides = { ...LOOSEN, rules: { ...(LOOSEN.rules as object), floorDecide: () => ({ reached: true, hollow_class: null, reason_code: "floor:reached", deterministic: false, fabricated_transcript: false }) } as never };
/** The d949f75-class mutant alone: the write-goal gate reverted to "never hollow". */
const REAL = await import("../../src/judge-rules/index");
export const GATE_REVERTED: ReplayOverrides = { rules: { reachGate: () => passV, floorDecide: (i) => REAL.floorDecide(i as never), floorShortcutAllowed: (i) => REAL.floorShortcutAllowed(i), reframeAccept: (i) => REAL.reframeAccept(i) } };

const green = corpus.cases.filter((c) => c.status_at_append === "green");
/**
 * RETIRED: cases recorded known_red at append whose fix has since landed, so they replay GREEN today. A case's
 * status_at_append is the record of its append, sealed by the manifest's hash chain and never rewritten; what
 * retires a fixed case live is the gate's ever-green record (classify / everRedCases), not an edit of the case.
 * Each id here must be known_red by record AND green today (asserted below), so a regression of its fix is red.
 */
const RETIRED: readonly string[] = ["0005-reframed-target-write"];
const isSeed = (c: CorpusCase) => !c.control && c.provenance.source !== "harness-scenario";

describe("MUST-FAIL: every green seed is red under the mutant that reinstates its false positive", () => {
  test("the corpus has green seeds and controls to test (else this block is vacuous)", () => {
    expect(green.filter(isSeed).length).toBeGreaterThanOrEqual(20);
    expect(green.filter((c) => c.control).length).toBeGreaterThanOrEqual(6);
  });
  for (const c of green.filter(isSeed)) test(`${c.id} is red under LOOSEN`, () => {
    expect(replayCase(c).outcome).toBe("green");
    expect([c.id, replayCase(c, LOOSEN).outcome]).toEqual([c.id, "red"]);
  });
  for (const id of RETIRED) test(`retired ${id} is green today and red under LOOSEN`, () => {
    const c = byId.get(id)!;
    expect([id, replayCase(c).outcome, replayCase(c, LOOSEN).outcome]).toEqual([id, "green", "red"]);
  });
  for (const c of green.filter((x) => x.control)) test(`control ${c.id} is red under TIGHTEN, or (a charge control) under LOOSEN`, () => {
    const m = c.expect.credit === "charged" ? LOOSEN : TIGHTEN;
    expect([c.id, replayCase(c, m).outcome]).toEqual([c.id, "red"]);
  });
  test("every green case with an open rule behind it is red under LOOSEN, TIGHTEN or ALWAYS_REACH (no case pins nothing)", () => {
    // completionShapes is the closed floor clamp F-b: no open rule exists to mutate, so it is pinned for the core only.
    const blind = green.filter((c) => c.entry !== "completionShapes" && [LOOSEN, TIGHTEN, ALWAYS_REACH].every((m) => replayCase(c, m).outcome === "green")).map((c) => c.id);
    expect(blind).toEqual([]);
  });
  test("M5: the write-goal gate reverted alone reddens the plan-text and prose-writeback seeds", () => {
    for (const id of ["0001-plan-text-as-change", "0002-prose-writeback-as-change"]) expect([id, replayCase(byId.get(id)!, GATE_REVERTED).outcome]).toEqual([id, "red"]);
    // the two write-claim seeds are still caught by the closed clamp with the gate reverted (two independent layers),
    // and turn red only when the clamp is off too (LOOSEN)
    for (const id of ["0003-zero-tool-write-claim-question", "0004-zero-tool-write-claim-change"]) {
      expect([id, replayCase(byId.get(id)!, GATE_REVERTED).outcome]).toEqual([id, "green"]);
      expect([id, replayCase(byId.get(id)!, { ...GATE_REVERTED, zeroToolClaimOff: true }).outcome]).toEqual([id, "red"]);
    }
  });
  test("positive control: a refactor with identical outputs (the real rules re-wrapped) keeps every green case green", async () => {
    const wrapped: ReplayOverrides = { rules: { reachGate: (i) => REAL.reachGate(i), floorDecide: (i) => REAL.floorDecide(i as never), floorShortcutAllowed: (i) => REAL.floorShortcutAllowed(i), reframeAccept: (i) => REAL.reframeAccept(i) } };
    expect(green.filter((c) => replayCase(c, wrapped).outcome !== "green").map((c) => c.id)).toEqual([]);
  });
  test("the known-red seeds are red today by record (S7 repeat-write credit, 17 floor rows); the RETIRED ones (S5 reframed target) are known_red by record and green today", () => {
    const kr = corpus.cases.filter((c) => c.status_at_append === "known_red").map((c) => c.id);
    expect(kr).toContain("0005-reframed-target-write");
    expect(kr).toContain("0011-repeat-write-refusal-charged");
    expect(kr.filter((id) => byId.get(id)!.class === "floor-unverified-reach").length).toBe(17);
    for (const id of RETIRED) expect([id, kr.includes(id)]).toEqual([id, true]);
    for (const id of kr) expect([id, replayCase(byId.get(id)!).outcome]).toEqual([id, RETIRED.includes(id) ? "green" : "red"]);
  });
});

describe("MUST-FAIL (anti-overfitting): a rule keyed on one surface text fails the other surfaces", () => {
  // Each need-derived class keeps its original case and carries two appended surface variants (A, B) with the
  // same mechanism and expected verdict. A rule that hollows only a text it has seen (otherwise loose) keeps that
  // case green and turns the other surfaces red.
  const ORIGINALS = ["0001-plan-text-as-change", "0002-prose-writeback-as-change", "0004-zero-tool-write-claim-change"];
  const families = ORIGINALS.map((o) => {
    const base = o.slice(5);
    const f = (v: string) => corpus.cases.find((c) => c.id.slice(5) === `${base}-variant-${v}`)!;
    return { orig: byId.get(o)!, a: f("a"), b: f("b") };
  });
  const goalOf = (c: CorpusCase) => (c.input as { goal: string }).goal;
  const keyedOn = (text: string): ReplayOverrides => ({ zeroToolClaimOff: true, rules: { ...(LOOSEN.rules as object), reachGate: (i) => (i.goal === text ? REAL.reachGate(i) : passV) } as never });
  test("each family has its original and both variants, all with distinct text and the same expectation", () => {
    for (const { orig, a, b } of families) {
      expect([orig, a, b].every(Boolean)).toBe(true);
      expect(new Set([goalOf(orig), goalOf(a), goalOf(b)]).size).toBe(3);
      expect(canonicalJson(a.expect)).toBe(canonicalJson(orig.expect));
      expect(canonicalJson(b.expect)).toBe(canonicalJson(orig.expect));
    }
  });
  for (const { orig, a, b } of families) {
    test(`keyed on the ORIGINAL ${orig.id}: original green, both variants red`, () => {
      const m = keyedOn(goalOf(orig));
      expect([orig.id, replayCase(orig, m).outcome, a.id, replayCase(a, m).outcome, b.id, replayCase(b, m).outcome]).toEqual([orig.id, "green", a.id, "red", b.id, "red"]);
    });
    test(`keyed on VARIANT A ${a.id}: variant A green, the original and variant B red`, () => {
      const m = keyedOn(goalOf(a));
      expect([a.id, replayCase(a, m).outcome, orig.id, replayCase(orig, m).outcome, b.id, replayCase(b, m).outcome]).toEqual([a.id, "green", orig.id, "red", b.id, "red"]);
    });
  }
});

describe("determinism guards", () => {
  const c = green.find((x) => x.entry === "reachGate")!;
  test("M19: a rule that consults Math.random (or the clock) is caught by the double run", () => {
    const rnd: ReplayOverrides = { rules: { ...(LOOSEN.rules as object), reachGate: () => (Math.random() < 0.5 ? passV : { reached: false, hollow_class: "write-goal-no-artifact", reason_code: "write-goal-no-artifact:write", deterministic: false }) } as never };
    expect(replayCase(c, rnd).outcome).toBe("nondeterministic");
    const clk: ReplayOverrides = { rules: { ...(LOOSEN.rules as object), reachGate: () => (Date.now() < 1.5e12 ? passV : { reached: false, hollow_class: "write-goal-no-artifact", reason_code: "write-goal-no-artifact:write", deterministic: false }) } as never };
    expect(replayCase(c, clk).outcome).toBe("nondeterministic");
  });
  test("fetch throws inside a replay and is restored after", () => {
    const before = globalThis.fetch;
    let threw = "";
    const f: ReplayOverrides = { rules: { ...(LOOSEN.rules as object), reachGate: () => { try { void fetch("http://127.0.0.1:9/"); } catch (e) { threw = String((e as Error).message); } return passV; } } as never };
    replayCase(c, f);
    expect(threw).toContain("fetch is not allowed");
    expect(globalThis.fetch).toBe(before);
  });
  test("an entry that does not exist is entry_missing, not green", () => {
    expect(replayCase({ ...c, id: "0000-x", entry: "noSuchEntry" } as CorpusCase).outcome).toBe("entry_missing");
  });
});

describe("compare and classify", () => {
  test("compare checks exactly the keys expect names, each by value", () => {
    expect(compare({ reached: false }, { reached: false, hollow_class: "x" })).toEqual([]);
    expect(compare({ reached: false, hollow_class: null }, { reached: false, hollow_class: "x" }).length).toBe(1);
    expect(compare({ completion_shapes: [] }, { completion_shapes: ["a"] }).length).toBe(1);
    expect(compare({ shortcut: "refused" }, {}).length).toBe(1);
  });
  const ids = (n: number) => corpus.cases.slice(0, n);
  test("M23: with no ever-green set, a red case recorded green at append is a FLIP (fail closed)", () => {
    const cs = ids(2).map((c, i) => ({ ...c, status_at_append: i === 0 ? "green" : "known_red" } as CorpusCase));
    const res = cs.map((c) => ({ id: c.id, outcome: "red" as const, diffs: ["x"], observed: null, ms: 0 }));
    const cl = classify(cs, res, null);
    expect(cl.flips).toEqual([cs[0]!.id]);
    expect(cl.known_red).toEqual([cs[1]!.id]);
  });
  test("with an ever-green set, only ever-green cases flip", () => {
    const cs = ids(2).map((c) => ({ ...c, status_at_append: "green" } as CorpusCase));
    const res = cs.map((c) => ({ id: c.id, outcome: "red" as const, diffs: ["x"], observed: null, ms: 0 }));
    expect(classify(cs, res, new Set([cs[1]!.id])).flips).toEqual([cs[1]!.id]);
  });
  test("holds are directional and carry since / review_by (72 h)", () => {
    const s1 = corpus.cases.find((c) => c.id === "0001-plan-text-as-change")!;
    const ctl = corpus.cases.find((c) => c.id === "0008-floor-knowledge-question-reaches")!;
    const h = holdsFrom([s1, ctl], { green: [], flips: [s1.id, ctl.id], known_red: [], entry_missing: [], nondeterministic: [] }, "2026-10-12T00:00:00.000Z");
    expect(h.map((x) => `${x.credit_class}:${x.direction}`).sort()).toEqual(["floor:zero-tool:hollow", "floor:zero-tool:reach"]);
    for (const x of h) expect(x.review_by).toBe("2026-10-15T00:00:00.000Z");
    const kept = holdsFrom([s1], { green: [], flips: [s1.id], known_red: [], entry_missing: [], nondeterministic: [] }, "2026-10-13T00:00:00.000Z", h);
    expect(kept[0]!.since).toBe("2026-10-12T00:00:00.000Z");
  });
});

describe("M13: append-check refuses a wrong status_at_append", () => {
  /** Runs the append check on a copy of the corpus: from the appended case when `mutate` appends one (as the CLI's
   *  append-check --from <n> does), else from the first case. */
  const withCorpus = (mutate: (d: string) => number | void) => {
    const d = mkdtempSync(join(tmpdir(), "vc-ac-"));
    try {
      cpSync(join(DIR, "MANIFEST.jsonl"), join(d, "MANIFEST.jsonl"));
      cpSync(join(DIR, "cases"), join(d, "cases"), { recursive: true });
      const from = mutate(d);
      return appendCheck(d, typeof from === "number" ? from : 1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  };
  const append = (d: string, c: CorpusCase): number => {
    const lines = readFileSync(join(d, "MANIFEST.jsonl"), "utf8").trimEnd().split("\n");
    const last = JSON.parse(lines[lines.length - 1]!);
    const n = last.n + 1;
    const id = `${String(n).padStart(4, "0")}-appended`;
    const cc = { ...c, id };
    const bytes = canonicalJson(cc);
    const path = `cases/${cc.class}/${id}.json`;
    writeFileSync(join(d, path), bytes);
    const sha = sha256Hex(bytes);
    lines.push(JSON.stringify({ n, id, path, case_sha256: sha, fidelity: cc.provenance.fidelity, prev: last.link, link: chainLink(last.link, n, id, sha) }));
    writeFileSync(join(d, "MANIFEST.jsonl"), lines.join("\n") + "\n");
    return n;
  };
  test("positive control: the corpus as committed observes every case's status_at_append, except each RETIRED case, reported as observed green", () => {
    expect(withCorpus(() => {})).toEqual({ ok: RETIRED.length === 0, mismatches: RETIRED.map((id) => `${id}: appended as known_red, observed green`) });
  });
  test("positive control: a green case appended as green passes the append check", () => {
    expect(withCorpus((d) => append(d, { ...byId.get("0001-plan-text-as-change")!, status_at_append: "green" }))).toEqual({ ok: true, mismatches: [] });
  });
  test("a red case appended as green is refused", () => {
    const r = withCorpus((d) => append(d, { ...byId.get("0011-repeat-write-refusal-charged")!, status_at_append: "green" }));
    expect(r.ok).toBe(false);
    expect(r.mismatches.length).toBe(1);
    expect(r.mismatches.join("\n")).toContain("appended as green, observed known_red");
  });
  test("a green case appended as known_red is refused", () => {
    const r = withCorpus((d) => append(d, { ...byId.get("0001-plan-text-as-change")!, status_at_append: "known_red" }));
    expect(r.mismatches.join("\n")).toContain("appended as known_red, observed green");
  });
  test("a case whose credit_class is not among the classes its input computes is refused", () => {
    const r = withCorpus((d) => append(d, { ...byId.get("0001-plan-text-as-change")!, credit_class: "template:hollow-charge" }));
    expect(r.mismatches.join("\n")).toContain("credit_class template:hollow-charge is not among");
  });
  test("GENESIS: the empty chain link is 64 zeros", () => { expect(GENESIS_LINK).toBe("0".repeat(64)); });
});

describe("the runner activity", () => {
  const sinks = (everGreen: string[] | null, excluded: string[] | null = ["repos/goal-host-vessel/src/judge/", "repos/goal-host-vessel/src/judge-rules/"]) => {
    const out = { statuses: [] as VerdictCorpusStatus[], reports: 0, gaps: [] as CorpusGap[] };
    return { out, s: { readPreviousStatus: async () => null, readEverGreen: async () => everGreen, readScopeExcluded: async () => excluded, writeStatus: async (st: VerdictCorpusStatus) => { out.statuses.push(st); }, recordReport: async () => { out.reports++; }, fileGap: async (g: CorpusGap) => { out.gaps.push(g); }, readGap: async () => null } };
  };
  test("a run publishes a status with holds for every red case and files one gap per red case", async () => {
    const { out, s } = sinks(corpus.cases.filter((c) => c.status_at_append === "green").map((c) => c.id));
    const st = await runVerdictCorpusActivity({ dir: DIR, node: "t", deployedSha: null, trigger: "test", nowMs: Date.parse("2026-10-12T00:00:00Z"), sinks: s });
    expect(st.state).toBe("ok");
    expect(st.flips).toEqual([]);
    expect(st.known_red.length).toBe(corpus.cases.filter((c) => c.status_at_append !== "green" && !RETIRED.includes(c.id)).length);
    for (const id of RETIRED) expect([id, st.green.includes(id)]).toEqual([id, true]);
    expect(out.reports).toBe(1);
    expect(out.gaps.map((g) => g.id).sort()).toEqual(st.known_red.map((id) => `verdict-corpus-red-${id}`).sort());
    for (const g of out.gaps) {
      expect(g.falsifier).toEqual({ class: "class1", check: "verdict-corpus-case", case_id: g.case_id });
      expect(g.evidence_resolve).toEqual({ shape: "test_suite", input: { vessel: "repos/goal-host-vessel", test_file: "test/verdict-corpus/case-check.check.ts", only_tests: [g.case_id!], timeout_ms: 60_000 }, zero_field: "requested_not_passing" });
      // before the judge opening every edit site is closed: operator review
      expect([g.id, g.route.to]).toEqual([g.id, "operator_review"]);
    }
    expect(st.holds.length).toBeGreaterThan(0);
  });
  test("M15: an unreadable corpus is corpus_unreadable and files a runner-failed gap (it holds every governed class: unreadable-corpus-holds.test.ts)", async () => {
    const d = mkdtempSync(join(tmpdir(), "vc-unread-"));
    try {
      cpSync(join(DIR, "cases"), join(d, "cases"), { recursive: true });
      writeFileSync(join(d, "MANIFEST.jsonl"), "");
      const { out, s } = sinks(null);
      const st = await runVerdictCorpusActivity({ dir: d, node: "t", deployedSha: null, trigger: "test", nowMs: Date.now(), sinks: s });
      expect(st.state).toBe("corpus_unreadable");
      expect(out.gaps.map((g) => g.id)).toEqual(["verdict-corpus-runner-failed-t"]);
      expect(readdirSync(d)).toContain("cases");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("routing follows the opening state read at use time: after the opening, rule-site gaps go to the lane; closed-core sites never do", async () => {
    const opened = sinks(null, ["repos/goal-host-vessel/src/judge/"]);
    await runVerdictCorpusActivity({ dir: DIR, node: "t", deployedSha: null, trigger: "test", nowMs: Date.now(), sinks: opened.s });
    const byRoute = (to: string) => opened.out.gaps.filter((g) => g.route.to === to).map((g) => g.edit_site);
    expect(byRoute("lane").length).toBeGreaterThan(0);
    expect(byRoute("lane").every((e) => e!.startsWith("repos/goal-host-vessel/src/judge-rules/"))).toBe(true);
    expect(byRoute("operator_review").every((e) => e!.startsWith("repos/goal-host-vessel/src/judge/"))).toBe(true);
    const unreadable = sinks(null, null);
    await runVerdictCorpusActivity({ dir: DIR, node: "t", deployedSha: null, trigger: "test", nowMs: Date.now(), sinks: unreadable.s });
    expect(unreadable.out.gaps.every((g) => g.route.to === "operator_review" && /fail closed/.test(g.route.reason))).toBe(true);
  });
  test("routeGap (pure): excluded -> operator review naming the entry; open -> lane; unreadable -> operator review", () => {
    expect(routeGap("repos/goal-host-vessel/src/judge-rules/floor.ts", ["repos/goal-host-vessel/src/judge-rules/"])).toMatchObject({ to: "operator_review", scope_entry: "repos/goal-host-vessel/src/judge-rules/" });
    expect(routeGap("repos/goal-host-vessel/src/judge-rules/floor.ts", ["repos/goal-host-vessel/src/judge/"]).to).toBe("lane");
    expect(routeGap("repos/goal-host-vessel/src/judge-rules/floor.ts", null).to).toBe("operator_review");
  });
  test("the case-check file registers exactly ONE test per case, titled by the case id (only_tests resolves to one test)", () => {
    const src = readFileSync(join(DIR, "case-check.check.ts"), "utf8");
    expect(src).toContain("for (const c of corpus.cases) test(c.id, () => {");
    const ids = corpus.cases.map((c) => c.id);
    for (const id of ids) expect([id, ids.filter((x) => x.includes(id)).length]).toEqual([id, 1]);
  });
  test("the class1 falsifier check is red while its case is red and green when it is green", () => {
    expect(checkCase(DIR, "0015-floor-row-01-citation-only").green).toBe(false);
    for (const id of RETIRED) expect([id, checkCase(DIR, id).green]).toEqual([id, true]);
    expect(checkCase(DIR, "0001-plan-text-as-change").green).toBe(true);
    expect(checkCase(DIR, "9999-no-such-case")).toMatchObject({ green: false, outcome: "no_such_case" });
  });
  test("M23: no ever-green set: the status says so, and a record-green red case would flip", async () => {
    const { s } = sinks(null);
    const st = await runVerdictCorpusActivity({ dir: DIR, node: "t", deployedSha: null, trigger: "test", nowMs: Date.now(), sinks: s });
    expect(st.ever_green).toBe("absent (fail closed)");
    expect(st.flips).toEqual([]);
  });
});

describe("MUST-FAIL: the runner re-derives each of its gaps' disposition on EVERY run from the live scope", () => {
  // A mirror of dev-vessel's composeEligibilitySkipReason on the fields this runner writes (the authoritative
  // function is exercised operator-side against dev-vessel's own module).
  const PARKING = ["needs_information", "needs_info", "awaiting_operator_review"];
  const eligibility = (row: GapRow): string | null => {
    const m = row.classification_metadata ?? {};
    if (String(row.status ?? "open") !== "open") return "not_open";
    const f = m["falsifier"] as { class?: string } | undefined;
    if (!["class1", "class2"].includes(String(f?.class ?? ""))) return "unarmed";
    if (!m["edit_site"]) return "no_edit_site";
    if (m["operator_hold"] === true || PARKING.includes(String(m["disposition"] ?? ""))) return "held";
    return null;
  };
  /** An in-memory gap store with the dev-vessel write semantics that matter here: omitted keys carry forward. */
  const store = () => {
    const rows = new Map<string, GapRow>();
    const write = (g: CorpusGap) => {
      const d = dispositionFor(g.route);
      const prev = rows.get(g.id);
      rows.set(g.id, { status: "open", severity: g.severity, classification_metadata: { ...(prev?.classification_metadata ?? {}), edit_site: g.edit_site, falsifier: g.falsifier, evidence_resolve: g.evidence_resolve, disposition: d, parked_by: d ? RUNNER_ID : "" } });
    };
    return { rows, write };
  };
  const CLOSED = ["repos/goal-host-vessel/src/judge/", "repos/goal-host-vessel/src/judge-rules/"];
  const OPEN = ["repos/goal-host-vessel/src/judge/"];
  const pass = async (st: ReturnType<typeof store>, excluded: string[] | null, plan = planGapWrite) => {
    await runVerdictCorpusActivity({ dir: DIR, node: "t", deployedSha: null, trigger: "test", nowMs: Date.parse("2026-10-12T00:00:00Z"), sinks: {
      readPreviousStatus: async () => null, readEverGreen: async () => null, readScopeExcluded: async () => excluded,
      writeStatus: async () => {}, recordReport: async () => {},
      readGap: async (id) => st.rows.get(id) ?? null,
      fileGap: async (g) => { if (plan === planGapWrite) st.write(g); else if (plan(st.rows.get(g.id) ?? null, g).write) st.write(g); },
    } });
  };
  const ruleGap = "verdict-corpus-red-0015-floor-row-01-citation-only"; // its edit site is under src/judge-rules/
  const coreGap = "verdict-corpus-red-0011-repeat-write-refusal-charged"; // its edit site is the closed core
  test("parked before the opening, eligible on the FIRST pass after its site opens, parked again if it closes", async () => {
    const st = store();
    await pass(st, CLOSED);
    expect(eligibility(st.rows.get(ruleGap)!)).toBe("held");
    await pass(st, OPEN);
    expect(eligibility(st.rows.get(ruleGap)!)).toBeNull();
    expect(st.rows.get(ruleGap)!.classification_metadata!["disposition"]).toBe("");
    expect(eligibility(st.rows.get(coreGap)!)).toBe("held"); // the closed core never goes to the lane
    await pass(st, CLOSED);
    expect(eligibility(st.rows.get(ruleGap)!)).toBe("held");
  });
  test("an unreadable scope parks (fail closed)", async () => {
    const st = store();
    await pass(st, OPEN);
    expect(eligibility(st.rows.get(ruleGap)!)).toBeNull();
    await pass(st, null);
    expect(eligibility(st.rows.get(ruleGap)!)).toBe("held");
  });
  test("RED under a mutant that derives the disposition only at filing time", async () => {
    const atFilingOnly: typeof planGapWrite = (row, g) => (row === null ? { write: true, why: "new" } : { write: false, why: "existing" });
    const st = store();
    const mutantPass = async (ex: string[] | null) => {
      await runVerdictCorpusActivity({ dir: DIR, node: "t", deployedSha: null, trigger: "test", nowMs: Date.now(), sinks: {
        readPreviousStatus: async () => null, readEverGreen: async () => null, readScopeExcluded: async () => ex, writeStatus: async () => {}, recordReport: async () => {},
        readGap: async () => null, // the mutant never consults the stored row
        fileGap: async (g) => { if (atFilingOnly(st.rows.get(g.id) ?? null, g).write) st.write(g); },
      } });
    };
    await mutantPass(CLOSED);
    await mutantPass(OPEN);
    expect(eligibility(st.rows.get(ruleGap)!)).toBe("held"); // stale park: the opening released nothing
  });
  test("planGapWrite never touches a hold it does not own, never reopens, and never releases blind", () => {
    const g = { id: "x", severity: "normal", category: "c", summary: "s", edit_site: "repos/goal-host-vessel/src/judge-rules/floor.ts", falsifier: null, case_id: "x", credit_class: null, evidence_resolve: null, route: { to: "lane", reason: "", scope_entry: null } } as CorpusGap;
    expect(planGapWrite({ status: "open", classification_metadata: { disposition: "pending_verification" } }, g).write).toBe(false);
    expect(planGapWrite({ status: "open", classification_metadata: { disposition: "awaiting_operator_review" } }, g).write).toBe(false); // a human's park
    expect(planGapWrite({ status: "open", classification_metadata: { disposition: "awaiting_operator_review", parked_by: RUNNER_ID } }, g)).toMatchObject({ write: true });
    expect(planGapWrite({ status: "closed", classification_metadata: {} }, g).write).toBe(false);
    expect(planGapWrite("unreadable", g).write).toBe(false);
    expect(planGapWrite("unreadable", { ...g, route: { to: "operator_review", reason: "", scope_entry: null } }).write).toBe(true);
  });
});

describe("MUST-FAIL: a verdictCorpusRun resolve is acknowledged at once; the replay runs after, single-flight", () => {
  // impulse-resolve aborts a resolve at IMPULSE_RESOLVE_TIMEOUT_MS (8 s). The handler must answer well inside that
  // whatever the replay costs; the run then completes and writes its status on its own.
  const SLOW_MS = 400; // a stand-in for a replay slower than the caller's bound
  const BOUND_MS = 100;
  const slowRun = (log: string[]) => async (trigger: string, runId: string) => {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    const st = await runVerdictCorpusActivity({ dir: DIR, node: "t", deployedSha: null, trigger, nowMs: Date.now(), sinks: {
      readPreviousStatus: async () => null, readEverGreen: async () => null, readScopeExcluded: async () => null, readGap: async () => null,
      writeStatus: async () => { log.push(`status:${runId}`); }, recordReport: async () => { log.push(`report:${runId}`); }, fileGap: async () => {},
    } });
    return st;
  };
  const timed = (f: () => unknown): number => { const t0 = performance.now(); f(); return performance.now() - t0; };
  test("the acknowledgement returns within the bound, and the run still completes and writes its status", async () => {
    const log: string[] = [];
    let n = 0;
    const acc = createRunAcceptor(slowRun(log), () => `run-${++n}`);
    let ack: ReturnType<typeof acc.accept> | null = null;
    expect(timed(() => { ack = acc.accept("rhythm"); })).toBeLessThan(BOUND_MS);
    expect(ack).toEqual({ accepted: true, status: "accepted", run_id: "run-1", trigger: "rhythm", gradable: false });
    expect(log).toEqual([]); // nothing ran before the acknowledgement
    expect(acc.accept("rhythm")).toMatchObject({ status: "in_flight", run_id: "run-1" }); // single-flight
    await acc.current();
    expect(log).toEqual(["status:run-1", "report:run-1"]);
    expect(acc.current()).toBeNull();
    expect(acc.accept("boot")).toMatchObject({ status: "accepted", run_id: "run-2" });
    await acc.current();
  });
  test("the checker sees a mutant handler that awaits the replay before answering", async () => {
    const log: string[] = [];
    const awaiting = async () => { await slowRun(log)("rhythm", "m"); return { accepted: true }; };
    const t0 = performance.now(); await awaiting();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(BOUND_MS); // over the bound: red under the bound check
  });
  test("the trigger is the pointer's (impulse-resolve posts {pointer}), else the body's, else rhythm", () => {
    expect(triggerOf({ trigger: "boot" }, { trigger: "x" })).toBe("boot");
    expect(triggerOf({}, { trigger: "manual" })).toBe("manual");
    expect(triggerOf(null, null)).toBe("rhythm");
    expect(triggerOf({ trigger: " " + "y".repeat(60) }, null)).toBe("y".repeat(40));
  });
});

describe("M14: no protected file skips on the environment", () => {
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".test.ts"))) test(`${f} has no skip / skipIf / todo / only`, () => {
    const src = readFileSync(join(DIR, f), "utf8").replace(/\/\/[^\n]*/g, "");
    expect([f, /\b(?:test|it|describe)\.(?:skip|skipIf|todo|only|if)\b/.test(src)]).toEqual([f, false]);
  });
  test("the check itself sees a planted skipIf", () => {
    const planted = "test" + ".skipIf(Bun.version !== \"1.4.2\")(\"x\", () => {})";
    expect(/\b(?:test|it|describe)\.(?:skip|skipIf|todo|only|if)\b/.test(planted)).toBe(true);
  });
});
