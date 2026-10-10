// THE CODE-INVESTIGATION CITATION ORACLE, BOTH DIRECTIONS, AND WHO PAYS FOR ITS VERDICT (OP-1 a, 2026-10-10).
//
// Measured over 24h on node 1 (goal-host bba1e55): 208 β events charged to a walk's LAST pick, 180 of them from
// this oracle — 122 "code-investigation-uncited", 58 "citation-unverified" — and the last pick was a
// memoryNote_write / substrateGap_write / activity_metrics satellite that recorded or followed the answer.
//   FALSE FAIL: the oracle ran for gap-investigation goals ("investigate and decompose gap <slug>"), which ask
//     for no citation, and returned reached:false deterministic:true for any uncited answer. deterministic:true
//     also defeated the walk's symmetric β withhold.
//   FALSE PASS: an answer passed when ANY cited file contained a goal word anywhere (778/778 cited answers
//     "achieved" on 10-05), so a citation to a line that says nothing about the claim was a reach.
//   CULPABILITY: the β landed, through the durable trace's reached:false tag and penaliseHollowTemplate
//     (/v2/activities/feedback), on the last pick whether or not it produced the judged artifact.
//
// THE RULES PINNED HERE:
//   1. The oracle grades only goals that ask for a code-cited investigation (citationOracleApplicability, which
//      is isCodeInvestigationGoal — the routing's own predicate). Not applicable ⇒ abstain (null), counted.
//   2. Uncited + applicable ⇒ not reached, deterministic only if the goal demanded citations.
//   3. A pass needs a cited file:LINE whose own line window holds the goal's symbol.
//   4. β goes only to the step that produced the judged artifact; a write satellite that recorded it gets none.
//   5. Abstains are counted per family; a family whose applicable-window abstain share exceeds the shaped
//      threshold logs a DIVERGENCE line.
//
// Hermetic: fetch is stubbed before index.ts is imported (the stub judge says not-reached, non-deterministic),
// WORKSPACE_ROOT is a temp dir, cited files are temp files addressed by absolute path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const JUDGE_MARK = "You verify whether a substrate execution REACHED";
const LLM_VESSEL = "http://llm-vessel.test.invalid/resolve";
const realFetch = globalThis.fetch;
const posts: string[] = [];
let judgeCalls = 0;
function stubFetch(input: unknown, init?: { body?: unknown }): Promise<Response> {
  const body = typeof init?.body === "string" ? init.body : "";
  posts.push(`${String(input)} ${body.slice(0, 200)}`);
  const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } }));
  if (body.includes(JUDGE_MARK)) {
    judgeCalls++;
    const verdict = JSON.stringify({ reached: false, reason: "stub judge: not enough", completion_shapes: [] });
    return json({ content: { body: { content: verdict } }, body: { content: verdict } });
  }
  if (body.includes('"vesselCapability"') && body.includes('"llm_completion"')) {
    return json({ content: { vessels: [{ id: "llm-test-vessel", endpoint: "http://llm-vessel.test.invalid", resolve_endpoint: LLM_VESSEL, protocol: "http" }] } });
  }
  return json({ error: "stub: not served" }, 404);
}

type V = { reached: boolean; reason?: string; deterministic?: boolean; abstain?: { kind: string; family?: string } } | null;
let mod: Record<string, any>;
let verifyGoalReached: (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string) => Promise<V>;
const prevRoot = process.env["WORKSPACE_ROOT"];
const root = mkdtempSync(join(tmpdir(), "op1-citation-"));
const SRC_FILE = join(root, "repo", "src", "signature.ts");
const SYMBOL = "computeOpOneSignature";
beforeAll(async () => {
  mkdirSync(join(root, "repo", "src"), { recursive: true });
  mkdirSync(join(root, "policies"), { recursive: true });
  // The symbol is DEFINED on line 50; lines 1-10 say nothing about it.
  const lines = Array.from({ length: 60 }, (_, i) => `// filler line ${i + 1}`);
  lines[2] = "import { readFile } from \"node:fs/promises\";";
  lines[49] = `export function ${SYMBOL}(shapes: string[]): string { return shapes.join("|"); }`;
  writeFileSync(SRC_FILE, lines.join("\n"));
  process.env["WORKSPACE_ROOT"] = root;
  globalThis.fetch = stubFetch as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  mod = (await import("../src/index")) as Record<string, any>;
  verifyGoalReached = mod.verifyGoalReached;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

const GAP_GOAL = "Investigate and decompose gap systematic-failure-universal-tool-fallback-zero";
const CODE_GOAL = `Find where ${SYMBOL} is defined in the codebase`;
const CODE_GOAL_DEMANDING = `Find where ${SYMBOL} is defined in the codebase and cite the file:line`;
const UNCITED = "- llm_completion: The failure comes from the fallback tier giving up after its retry budget; decompose it into a budget gap and a retry gap.";

describe("(a1) MUST-FAIL — false fail: a goal that asked for no citation is never failed for lacking one", () => {
  test("a gap-investigation goal with an uncited answer gets no citation verdict: an UNGRADED abstain, counted, never the judge", async () => {
    const judgedBefore = judgeCalls;
    const countedBefore = mod.oracleAbstainCounts()["code-investigation-citation"]?.notApplicable ?? 0;
    const v = await verifyGoalReached(GAP_GOAL, ["goal", "llm_completion"], "walk(3 steps)", UNCITED);
    expect(v?.reason ?? "").not.toMatch(/code-investigation-uncited/);
    expect(v?.deterministic === true && v?.reached === false).toBe(false);
    // Ungraded for posterior purposes: an abstain (the walk withholds β and the dispatch delivers no reach verdict),
    // and NOT handed to the LLM judge — no judge of measured adequacy exists for this class.
    expect(v?.abstain?.kind).toBe("oracle-abstain");
    expect(v?.reason ?? "").toMatch(/^abstain:/);
    expect(judgeCalls).toBe(judgedBefore);
    expect(mod.oracleAbstainCounts()["code-investigation-citation"].notApplicable).toBe(countedBefore + 1);
  });

  test("an abstained dispatch posts no reach verdict: the record's reached is null, and deliverReachVerdict sends nothing for it", async () => {
    const before = posts.filter((p) => p.includes("/execution-traces/reach")).length;
    mod.deliverReachVerdict("walk-satisfier-3-1791378965133", null, [], "walk-complete", "abstain:code-investigation-citation", "abc", null);
    await new Promise((r) => setTimeout(r, 20));
    expect(posts.filter((p) => p.includes("/execution-traces/reach")).length).toBe(before);
    const src = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
    // The handler turns an abstained walk into reached:null (pinned by the existing §9.2 path) …
    expect(src).toContain("if (seek.abstain) {\n        record.reached = null;");
    // … the walk withholds β on the durable trace for any abstain …
    expect(src).toContain("if (verdict?.abstain) {\n        status = \"failed\";\n        walkBetaWithheld = true;");
    // … the floor persists an abstain untagged + beta_withheld, and the engine path neither penalises nor reports reached:false.
    expect(src).toContain('tags: verdict?.abstain ? withBetaWithheld(["dispatcher_used:goal-host"], "verdict-abstain") : [');
    expect(src).toMatch(/\} else if \(verdict\?\.abstain\) \{\n\s*\/\/ ABSTAIN \(OP-1\)[^\n]*\n\s*status = "failed";\n\s*goalReachReason = verdict\.reason;\n\s*tap\([^\n]*ungraded \(no β\)`\);\n\s*\} else if \(verdict && verdict\.reached === false\) \{/);
    expect(src).toContain("...(engineAbstain && !reached ? { abstain: engineAbstain } : {})");
  });

  test("an applicable goal that did not demand citations: uncited is not reached, but NOT deterministic", async () => {
    const v = await verifyGoalReached(CODE_GOAL, ["goal", "llm_completion"], "walk(2 steps)", UNCITED);
    expect(v?.reached).toBe(false);
    expect(v?.deterministic).not.toBe(true);
    expect(v?.reason ?? "").not.toMatch(/^deterministic:/);
  });

  test("CONTROL: a goal that demanded citations, uncited, is a deterministic miss", async () => {
    const v = await verifyGoalReached(CODE_GOAL_DEMANDING, ["goal", "llm_completion"], "walk(2 steps)", UNCITED);
    expect(v?.reached).toBe(false);
    expect(v?.deterministic).toBe(true);
    expect(v?.reason ?? "").toMatch(/^deterministic:code-investigation-uncited/);
  });

  test("applicability is the shared routing predicate, plus the one demanded-citation pattern", async () => {
    const gti = await import("../src/goal-target-inference");
    expect(gti.citationOracleApplicability(GAP_GOAL)).toBe("not-applicable");
    expect(gti.citationOracleApplicability(CODE_GOAL)).toBe("applicable");
    expect(gti.citationOracleApplicability(CODE_GOAL_DEMANDING)).toBe("demanded");
    for (const g of [GAP_GOAL, CODE_GOAL, CODE_GOAL_DEMANDING, "What is the weather today?"]) {
      expect(gti.citationOracleApplicability(g) !== "not-applicable").toBe(gti.isCodeInvestigationGoal(g));
    }
  });
});

describe("(a2) MUST-FAIL — false pass: a cited file that merely contains the goal word is not support", () => {
  test("citing a line that does not hold the symbol is NOT achieved, though the file holds it elsewhere", async () => {
    const v = await verifyGoalReached(CODE_GOAL, ["goal", "llm_completion"], "walk(2 steps)", `- llm_completion: ${SYMBOL} is defined at ${SRC_FILE}:3, where it is created from the shape list.`);
    expect(v?.reached).not.toBe(true);
    expect(v?.reason ?? "").toMatch(/citation-unverified/);
  });

  test("a whole-file citation (no line) is not a pass either: the location it claims is uncheckable (ungraded abstain)", async () => {
    const judgedBefore = judgeCalls;
    const v = await verifyGoalReached(CODE_GOAL, ["goal", "llm_completion"], "walk(2 steps)", `- llm_completion: ${SYMBOL} lives in ${SRC_FILE}.`);
    expect(v?.reached).not.toBe(true);
    expect(v?.abstain?.kind).toBe("oracle-abstain");
    expect(judgeCalls).toBe(judgedBefore);
  });

  test("CONTROL: citing the line that holds the symbol IS achieved", async () => {
    const v = await verifyGoalReached(CODE_GOAL, ["goal", "llm_completion"], "walk(2 steps)", `- llm_completion: ${SYMBOL} is defined at ${SRC_FILE}:50.`);
    expect(v?.reached).toBe(true);
    expect(v?.reason ?? "").toMatch(/code-investigation-cited/);
  });

  test("CONTROL: a line past the end of the file is unsupported", async () => {
    const v = await verifyGoalReached(CODE_GOAL, ["goal", "llm_completion"], "walk(2 steps)", `- llm_completion: see ${SRC_FILE}:900`);
    expect(v?.reached).not.toBe(true);
  });
});

// The walk [read, llmCompletion, substrateGap_write]: the read produced fileContent, the LLM step consumed it
// and produced the answer, the write satellite consumed the answer and recorded it.
const EDGES = [
  { inputShapes: [], inputImpulseIds: [], outputShapes: ["fileContent"], outputImpulseIds: ["p-file"] },
  { inputShapes: ["fileContent"], inputImpulseIds: ["p-file"], outputShapes: ["llmCompletion"], outputImpulseIds: ["p-llm"] },
  { inputShapes: ["llmCompletion"], inputImpulseIds: ["p-llm"], outputShapes: ["substrateGap_write"], outputImpulseIds: ["p-gap"] },
];
const POOL = [
  { shape: "goal", content: GAP_GOAL },
  { shape: "fileContent", content: "export const x = 1;" },
  { shape: "llmCompletion", content: UNCITED.slice("- llm_completion: ".length) },
  { shape: "substrateGap_write", content: { resolved: true, gap: { id: "gap-x", summary: "decomposed" } } },
];

describe("(a3) MUST-FAIL — culpability: a not-reached verdict about the answer charges no β to a write satellite last", () => {
  test("the judged artifact's producer is the LLM step, not the write that recorded it", async () => {
    const wp = await import("../src/walk-pool");
    const jv = await import("../src/judge-view");
    const view = jv.buildJudgeView(POOL, new Set(["substrateGap_write"]));
    expect(view.deliverableShapes).toEqual(expect.arrayContaining(["llmCompletion", "substrateGap_write"]));
    const c = wp.lastStepCulpability(EDGES, new Set(view.deliverableShapes), false);
    expect(c.producers).toEqual([1]);
    expect(c.culpable).toBe(false);
  });

  test("CONTROLS: the producer last is culpable; a last step that failed itself is culpable; a write that bound nothing authored what it wrote", async () => {
    const wp = await import("../src/walk-pool");
    expect(wp.lastStepCulpability(EDGES.slice(0, 2), new Set(["llmCompletion"]), false).culpable).toBe(true);
    expect(wp.lastStepCulpability(EDGES, new Set(["llmCompletion"]), true).culpable).toBe(true);
    const unbound = [EDGES[0]!, EDGES[1]!, { inputShapes: [], inputImpulseIds: [], outputShapes: ["substrateGap_write"], outputImpulseIds: ["p-gap"] }];
    expect(wp.lastStepCulpability(unbound, new Set(["substrateGap_write"]), false).culpable).toBe(true);
    // No producer identifiable (nothing produced a judged shape): not culpable — an unavailable observation is not a negative.
    expect(wp.lastStepCulpability(EDGES, new Set(["summary"]), false)).toEqual({ culpable: false, producers: [] });
  });

  const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
  const start = SRC.indexOf("} else if (verdict && verdict.reached === false) {");
  const end = SRC.indexOf("} else if (verdict && verdict.reached === true) {", start);
  const branch = start >= 0 && end > start ? SRC.slice(start, end) : "";
  test("wiring: the walk decides culpability from the judge view's deliverable shapes and the last step's own status", () => {
    expect(branch).toContain("lastStepCulpability(chain.map((_, i) => stepEdges.get(i)), new Set([...(verdict.completion_shapes ?? []), ...judgeView.deliverableShapes]), lastTrace.status === \"failed\", stepIsStub)");
    expect(branch).toContain("const _betaWithheldForCulpability = !_noOracle && !_betaWithheldForSymmetry && !_culpability.culpable;");
  });
  test("wiring: a non-culpable last pick is withheld (no reached:false on its durable trace) and gets no /feedback negative", () => {
    // walkBetaWithheld is what the durable persist reads: withheld ⇒ the trace persists untagged + beta_withheld.
    expect(branch).toContain("if (_betaWithheldForCulpability) walkBetaWithheld = true;");
    expect(branch).toMatch(/if \(_betaWithheldForCulpability\) tap\([^\n]*\n\s*else opts\.learningSink\?\.alphaBetaDelta\.push\(await penaliseHollowTemplate\(lastPick,/);
    expect(branch.split("penaliseHollowTemplate(").length - 1).toBe(1);
    expect(branch).toContain('"not-producer-of-judged-artifact"');
    const persist = SRC.slice(SRC.indexOf("if (satisfierOnlyTrace) {"), SRC.indexOf("if (satisfierOnlyTrace) {") + 3000);
    expect(persist).toContain('tags: (!reached && walkBetaWithheld) ? _existingTags : [..._existingTags, reached ? "reached:true" : "reached:false"],');
  });
  test("wiring: the failed composite (the producer's carrier) is still recorded when only culpability withheld β", () => {
    expect(branch).toMatch(/if \(!_noOracle && !_betaWithheldForSymmetry && chain\.length >= 2 && _lastIsSatisfier\) \{/);
  });
});

describe("(a4) abstains are counted per family, with a divergence counterweight", () => {
  test("a not-applicable goal is counted (and logged) as a not-applicable decision of the citation family", async () => {
    const before = mod.oracleAbstainCounts()["code-investigation-citation"]?.notApplicable ?? 0;
    await verifyGoalReached(GAP_GOAL, ["goal", "llm_completion"], "walk", UNCITED);
    expect(mod.oracleAbstainCounts()["code-investigation-citation"].notApplicable).toBe(before + 1);
  });

  test("the divergence line fires once the applicable-window abstain share exceeds the threshold, and not before", async () => {
    const { createOracleAbstainTally } = await import("../src/oracle-abstain");
    const t = createOracleAbstainTally();
    const th = { window: 4, share: 0.5 };
    expect(t.record("f", "abstain", th).divergenceLine).toBeNull(); // window not full yet
    expect(t.record("f", "not-applicable", th).divergenceLine).toBeNull(); // kept out of the share
    expect(t.record("f", "verdict", th).divergenceLine).toBeNull();
    const r = t.record("f", "abstain", th); // applicable window [abstain, verdict, abstain]: 2 of 3, above 0.5
    expect(r.divergenceLine).toBeNull(); // …but the window is not full, so the share is not yet a measurement
    const d = t.record("f", "abstain", th); // [abstain, verdict, abstain, abstain]: 3 of 4
    expect(d.windowShare).toBe(0.75);
    expect(d.divergenceLine).toMatch(/DIVERGENCE family=f abstain_share=0\.75/);
    expect(t.record("f", "abstain", th).divergenceLine).toBeNull(); // not repeated every decision
    expect(t.counts()["f"]).toEqual({ decisions: 6, verdicts: 1, abstains: 4, notApplicable: 1 });
  });

  test("the thresholds are shaped tuning values with law-1 defaults", async () => {
    const st = await import("../src/selection-tuning");
    expect(st.SELECTION_TUNING_DEFAULTS.oracleAbstainWindow).toBe(50);
    expect(st.SELECTION_TUNING_DEFAULTS.oracleAbstainDivergenceShare).toBe(0.5);
  });
});
