// A READ GOAL NEVER INFERS A MUTATION TARGET, AND ITS TARGETS ALONE NEVER MAKE IT A WRITE GOAL (CHANGE-35 / A2a).
//
// RUN 0 (2026-10-16): 8 of 17 random read and question goals had write targets inferred (fileEditResult,
// activityTemplate_write, an http write, …); the reach gate's targets clause then made each a write goal, and it
// hollowed as write-goal-no-artifact. The read rule (src/read-goal.ts) is a CLOSED copy of the gate's question rule
// (only src/judge/entries.ts may import the open rules); the last describe pins that the two agree.
//
//   [MUST-FAIL] RUN 0 pos 1, "What is the weather forecast …": the inferred mutation target is dropped (LLM path), so
//               the reach gate, which reads the inferred targets, no longer sees a write goal. goalRequiresArtifact is
//               unchanged: its protected pin (test/write-goal-artifact.test.ts) keeps "a mutation-shape target alone is
//               write intent".
//   [MUST-FAIL] a prose "shape" is not a shape name, so neither the learned-deliverable feed nor expected_output_shapes
//               admits it (pins at both feeds).
//   [MUST-FAIL] RUN 0 pos 5: the REGISTRY advertised it (development-vessel config.ts); a vocabulary containing it does
//               not let it through inference, and fetchKnownShapes refuses it from the union of all feeds.
//   [CONTROL]   "update X to Y" still infers its write target and stays a write goal; "Can you update X to Y?" too.
//   [CONTROL]   a read goal's non-mutation targets are kept; a question that asks to save a note keeps its write.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { inferGoalTargetDecision } from "../../src/goal-target-inference";
import * as WG from "../../src/judge-rules/write-goal";
const SN = (await import("../../src/shape-name").catch(() => ({}))) as Record<string, any>;
const RG = (await import("../../src/read-goal").catch(() => ({}))) as Record<string, any>;

// llm_completion_dispatch is left OUT so the deterministic prose route cannot answer first: the LLM path is exercised.
const KNOWN = ["webSearchResult", "fileEditResult", "activityTemplate_write", "memoryNote_write", "shellResult"];
const llm = (shapes: string[]) => ({ complete: async () => `Here:\n${JSON.stringify({ target_shapes: shapes })}\n` });
const WEATHER = "What is the weather forecast for Paris tomorrow?";

describe("a read goal never infers a write target", () => {
  it("[MUST-FAIL] RUN 0 pos 1: the mutation target is dropped and the targets alone make no write goal", async () => {
    const d = await inferGoalTargetDecision(WEATHER, KNOWN, llm(["fileEditResult", "webSearchResult"]));
    expect(d.shapes).not.toContain("fileEditResult");
    expect(d.alternatives.flat()).not.toContain("fileEditResult");
    expect(typeof (RG as Record<string, unknown>)["isReadQuestionGoal"]).toBe("function");
    // The reach gate reads the INFERRED targets (inferredTargetDecisionCache), so with the mutation target dropped
    // upstream the gate sees none: the weather goal is not a write goal.
    expect(WG.goalRequiresArtifact(WEATHER, d.shapes)).toBe(false);
  });

  it("[MUST-FAIL] a prose 'shape' is refused at both feeds", () => {
    expect(typeof SN["isShapeName"]).toBe("function");
    expect(SN.isShapeName("code_quality with substantive assessment content")).toBe(false);
    for (const ok of ["code_quality", "obsidian:write_note", "lifecycle:task:completed", "development-vessel:coverage-tick", "webSearchResult"]) expect(SN.isShapeName(ok)).toBe(true);
    const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(src).toContain("const shapes = rawShapes.filter(isShapeName);");
    expect(src).toContain("(body.expected_output_shapes as unknown[]).filter((s): s is string => { const ok = isShapeName(s);");
  });

  it("[MUST-FAIL] RUN 0 pos 5: a vocabulary that CONTAINS the prose name does not let it through inference", async () => {
    const PROSE = "code_quality with substantive assessment content";
    const d = await inferGoalTargetDecision("Assess the code quality of the clock vessel and write a test report", [...KNOWN, PROSE, "test_report_write"], llm([PROSE, "test_report_write"]));
    expect(d.shapes).not.toContain(PROSE);
    expect(d.alternatives.flat()).not.toContain(PROSE);
    const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(src).toContain("if (isShapeName(s)) return true;");
  });

  it("[CONTROL] a change goal keeps its write target and stays a write goal", async () => {
    const upd = "update the README in repos/demo-vessel to describe the new flag";
    const d = await inferGoalTargetDecision(upd, KNOWN, llm(["fileEditResult"]));
    expect(d.shapes).toContain("fileEditResult");
    expect(WG.goalRequiresArtifact(upd, ["fileEditResult"])).toBe(true);
    expect(RG.isReadQuestionGoal("Can you update repos/demo-vessel/src/x.ts to export y?")).toBe(false);
  });

  it("[CONTROL] a read goal's non-mutation targets are kept; asking to save a note keeps the write", async () => {
    const d = await inferGoalTargetDecision(WEATHER, KNOWN, llm(["webSearchResult"]));
    expect(d.shapes).toEqual(["webSearchResult"]);
    expect(RG.isReadQuestionGoal("What is the weather tomorrow? Save it as a note in my vault.")).toBe(false);
    expect(RG.isQuestionGoal("Is the build green")).toBe(true);
    expect(RG.isQuestionGoal("investigate gap X before composing")).toBe(false);
  });
});

// The closed copy (src/read-goal.ts) and the open rule (src/judge-rules/write-goal.ts) must agree; this directory may read both.
describe("the closed read rule agrees with the reach gate's question rule", () => {
  it("QUESTION_LEAD is the same expression in both files", () => {
    const lead = (rel: string) => /const QUESTION_LEAD = (\/.+\/[a-z]*);/.exec(readFileSync(new URL(rel, import.meta.url), "utf8"))?.[1];
    expect(lead("../../src/read-goal.ts")).toBeTruthy();
    expect(lead("../../src/read-goal.ts")).toBe(lead("../../src/judge-rules/write-goal.ts"));
  });
  it("for every goal, a read goal is exactly a question the open rule says asks for no change and no durable record", () => {
    const GOALS = [WEATHER, "Is the build green", "Is the build green?", "investigate gap X before composing",
      "Can you update repos/demo-vessel/src/x.ts to export y?", "What is the weather tomorrow? Save it as a note in my vault.",
      "update the README in repos/demo-vessel to describe the new flag", "How many modules are under repos/x/src?",
      "Could you fix gap gap-123 in repos/demo-vessel/src/a.ts?", "why does the walk choose webSearchResult", "list the vessels", "",
      "Should we record the findings as a durable note?", "Which activity produced fileEditResult last?"];
    for (const g of GOALS) {
      const openQuestion = !!g && !WG.goalAsksForBehaviourChange(g) && (/\?\s*$/.test(g.trim()) || RG.QUESTION_LEAD.test(g));
      const openRead = openQuestion && !WG.goalAsksForChange(g) && !WG.goalRequiresArtifact(g, []);
      expect([g, RG.isReadQuestionGoal(g)]).toEqual([g, openRead]);
    }
  });
  it("the imperative leads are the same expressions in both files", () => {
    expect(RG.IMPERATIVE_CHANGE_LEAD?.source).toBe(WG.IMPERATIVE_CHANGE_LEAD.source);
    expect(RG.IMPERATIVE_CHANGE_LEAD?.flags).toBe(WG.IMPERATIVE_CHANGE_LEAD.flags);
    expect(RG.IMPERATIVE_WRITE_LEAD?.source).toBe(WG.IMPERATIVE_WRITE_LEAD.source);
    expect(RG.IMPERATIVE_WRITE_LEAD?.flags).toBe(WG.IMPERATIVE_WRITE_LEAD.flags);
  });
  it("for every goal, the closed goalDemandsArtifact is exactly the open goalRequiresArtifact with no targets", () => {
    expect(typeof RG.goalDemandsArtifact).toBe("function");
    const GOALS = [WEATHER, "Is the build green", "investigate gap X before composing", "list the vessels", "",
      "Summarise the three oldest open substrate gaps and record a concept capturing the summary",
      "File a gap about the retry dropping its write target", "Write ONE failing test for the floor wrapper",
      "Write a summary of the registry", "Make the system notice a stale memo", "why does the gate stop it",
      "Can you update repos/demo-vessel/src/x.ts to export y?", "update the README in repos/demo-vessel to describe the new flag",
      "Could you fix gap gap-123 in repos/demo-vessel/src/a.ts?", "Should we record the findings as a durable note?",
      "Print /workspace/docs/plan.txt verbatim", "Please add a row to the ledger. Then report it."];
    for (const g of GOALS) expect([g, RG.goalDemandsArtifact(g)]).toEqual([g, WG.goalRequiresArtifact(g, [])]);
  });
});

// STRUCTURAL drift, not only regex drift: the closed goalDemandsArtifact against the open goalRequiresArtifact (no targets)
// over the goals the repo already holds — every `goal` in the verdict and routing corpora, and every goal literal the
// goal-intent sweeps and the write-goal gate's own tests pass to an intent predicate. A clause added to either side that
// the other lacks splits them on some real goal here. Counted, so an empty read cannot pass.
describe("the closed artifact rule agrees with the open gate over the existing goal corpora", () => {
  const goalsIn = (o: unknown, out: Set<string>): void => {
    if (Array.isArray(o)) { for (const v of o) goalsIn(v, out); return; }
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === "goal" && typeof v === "string") out.add(v); else goalsIn(v, out);
    }
  };
  const corpusGoals = (rel: string): Set<string> => {
    const out = new Set<string>();
    const root = new URL(rel, import.meta.url);
    for (const f of readdirSync(root, { recursive: true }) as string[]) {
      if (f.endsWith(".json")) goalsIn(JSON.parse(readFileSync(new URL(`${rel}/${f}`, import.meta.url), "utf8")), out);
    }
    return out;
  };
  const PREDICATE_CALL = /\b(?:goalRequestsDurableArtifact|goalAsksForChange|goalAsksForBehaviourChange|goalRequiresArtifact|isEditIntentGoal|goalDemandsLandedEdit|isGapRepairGoal|writeGoalArtifactGate)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  const literalGoals = (): Set<string> => {
    const out = new Set<string>();
    const src = new URL("../../src/", import.meta.url);
    const files = [...(readdirSync(src) as string[]).filter((f) => /^goal-intent.*\.test\.ts$/.test(f)).map((f) => new URL(f, src)), new URL("../write-goal-artifact.test.ts", import.meta.url)];
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(PREDICATE_CALL)) out.add(m[2]!.replace(/\\(.)/g, "$1"));
    return out;
  };
  it("every corpus goal and every sweep goal: goalDemandsArtifact === goalRequiresArtifact(goal, [])", () => {
    const verdict = corpusGoals("../verdict-corpus/cases");
    const routing = corpusGoals("../routing-corpus/cases");
    const literal = literalGoals();
    expect(verdict.size).toBeGreaterThanOrEqual(40);
    expect(routing.size).toBeGreaterThanOrEqual(10);
    expect(literal.size).toBeGreaterThanOrEqual(30);
    const all = [...new Set([...verdict, ...routing, ...literal])];
    const split = all.filter((g) => RG.goalDemandsArtifact(g) !== WG.goalRequiresArtifact(g, []));
    expect(split).toEqual([]);
    // Both answers occur, so the agreement is not one constant matching another.
    const yes = all.filter((g) => WG.goalRequiresArtifact(g, [])).length;
    console.log(`[agreement] ${all.length} goals (verdict ${verdict.size}, routing ${routing.size}, literal ${literal.size}); demand an artifact: ${yes}`);
    expect(yes).toBeGreaterThan(0);
    expect(yes).toBeLessThan(all.length);
  });
});
