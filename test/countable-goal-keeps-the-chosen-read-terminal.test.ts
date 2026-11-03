// A COUNTABLE GOAL KEEPS THE CHOSEN READ AS ITS TERMINAL (gap deterministic-shellresult-shortcuts-return-before-the-
// advertised-shape-vocabulary-is-consulted-...; the countable-goal appender is its remaining instance). After the CHOICE
// (the chooser shown the described candidates) picked an answer-bearing read for a "how many" goal, the appender added
// shellResult LAST, the derivation made it the terminal, and the chosen read became an intermediate the shell never
// consumed. Now shellResult is held as an alternative there; with no such choice it is appended as before.
//
// The appender is inline in runGoalWithRecoveryInner, so its own code is cut from src/index.ts by anchor and evaluated
// (TypeScript stripped by Bun's transpiler), never re-implemented. Shape names are synthetic.
import { describe, expect, test } from "bun:test";
import { isCountableQuestion } from "../src/quantitative-goal";
import { proseProducerOf } from "../src/shape-recall";
import { isWriteShape } from "../src/walk-pool";
import { isMutationShape } from "../src/judge/shapes";

const SRC = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const START = "      const namedProducerInferred = !!(";
const END = "      // SHELL SAFETY NET (FIX B, 2026-07-23)";
const BLOCK = (() => { const i = SRC.indexOf(START); expect(i).toBeGreaterThan(-1); const j = SRC.indexOf(END, i); expect(j).toBeGreaterThan(i); return SRC.slice(i, j); })();
const JS = new Bun.Transpiler({ loader: "ts", deadCodeElimination: false }).transformSync(BLOCK);

type Decision = { shapes: string[]; confidence: number; alternatives: string[][]; chooser_tier?: string };
function appender(goal: string, decision: Decision, knownShapes: string[]) {
  const logs: string[] = [];
  const body = `let seededOutputShapes = decision.shapes.length > 0 ? decision.shapes : null; let goalTargetDecision = decision;
    ${JS}
    return { seeded: seededOutputShapes, gtd: goalTargetDecision };`;
  const r = new Function("goal", "decision", "knownShapes", "opts", "tap", "isCountableQuestion", "proseProducerOf", "isWriteShape", "isMutationShape", body)(
    goal, decision, knownShapes, { surface: "test" }, (l: string) => logs.push(l), isCountableQuestion, proseProducerOf, isWriteShape, isMutationShape,
  ) as { seeded: string[] | null; gtd: Decision };
  return { ...r, logs };
}

const KNOWN = ["panelRuleScan", "cadenceDriftAudit", "gapTally", "shellResult", "llm_completion_dispatch", "memoryNote_write"];
const COUNT_GOAL = "How many panels broke a legibility rule on the latest scan?";
const llm = (shapes: string[]): Decision => ({ shapes, confidence: 0.9, alternatives: [], chooser_tier: "llm" });

describe("[MUST-FAIL] the chooser picked an answer-bearing read for a countable goal: it stays the terminal", () => {
  test("one chosen read: no shellResult appended; shellResult is an alternative", () => {
    const d = llm(["panelRuleScan"]);
    expect(isCountableQuestion(COUNT_GOAL)).toBe(true);
    const r = appender(COUNT_GOAL, d, KNOWN);
    expect(r.seeded).toEqual(["panelRuleScan"]);
    expect(r.gtd.alternatives).toContainEqual(["shellResult"]);
    expect(d.alternatives).toEqual([]); // the chooser's (possibly cached) decision is not mutated
  });
  test("several chosen reads: all kept, the last read stays the terminal", () => {
    const r = appender("What is the total number of drifted cadences and open gaps right now?", llm(["cadenceDriftAudit", "gapTally"]), KNOWN);
    expect(r.seeded).toEqual(["cadenceDriftAudit", "gapTally"]);
    expect(r.seeded![r.seeded!.length - 1]).toBe("gapTally");
    expect(r.gtd.alternatives).toContainEqual(["shellResult"]);
  });
});

describe("CONTROLS: everything else is appended (or left) as before", () => {
  test("no CHOICE ran (deterministic / fallback tier): shellResult appended as the terminal", () => {
    for (const tier of ["deterministic", "fallback", undefined]) {
      const r = appender(COUNT_GOAL, { shapes: ["panelRuleScan"], confidence: 0.6, alternatives: [], chooser_tier: tier }, KNOWN);
      expect(r.seeded).toEqual(["panelRuleScan", "shellResult"]);
      expect(r.logs.join("\n")).toContain("APPENDED shellResult to inferred targets");
    }
  });
  test("the choice is not answer-bearing (a write, or the prose producer): shellResult appended", () => {
    expect(appender(COUNT_GOAL, llm(["gapTally", "memoryNote_write"]), KNOWN).seeded).toEqual(["gapTally", "memoryNote_write", "shellResult"]);
    expect(appender(COUNT_GOAL, llm(["llm_completion_dispatch"]), KNOWN).seeded).toEqual(["llm_completion_dispatch", "shellResult"]);
  });
  test("a non-countable goal is untouched", () => {
    const r = appender("Describe what the latest panel scan checks.", llm(["panelRuleScan"]), KNOWN);
    expect(r.seeded).toEqual(["panelRuleScan"]);
    expect(r.gtd.alternatives).toEqual([]);
  });
  test("a goal naming the inferred producer is untouched (the existing named-producer exception)", () => {
    const r = appender("How many rules did panelRuleScan check?", { shapes: ["panelRuleScan"], confidence: 0.6, alternatives: [], chooser_tier: "deterministic" }, KNOWN);
    expect(r.seeded).toEqual(["panelRuleScan"]);
  });
  test("no shellResult in the vocabulary: nothing appended or held", () => {
    const r = appender(COUNT_GOAL, { shapes: ["panelRuleScan"], confidence: 0.6, alternatives: [], chooser_tier: "deterministic" }, KNOWN.filter((s) => s !== "shellResult"));
    expect(r.seeded).toEqual(["panelRuleScan"]);
  });
  test("the B1 marker path is unchanged", () => {
    const gti = require("node:fs").readFileSync(`${import.meta.dir}/../src/goal-target-inference.ts`, "utf8") as string;
    expect(gti).toContain("held as a candidate; the chooser chose");
  });
});
