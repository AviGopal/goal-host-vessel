// THE PROSE PRODUCER IS A RECALL CANDIDATE WHEN NO ANSWER SHAPE WAS RECALLED.
//
// Shape recall matches the goal against the shape index, which describes shapes by where they were used. A general
// question (10-28: a general how-to question) recalled only internal shapes, and the chooser, which
// may pick only from the recalled list, confabulated maintenanceLease/repairPolicy; every retry drew from the same list.
// The advertised prose producer (proseProducerOf: llm_completion_dispatch, else llm_completion; the prose route's own
// choice) now joins the candidates, beside the goal class's recorded targets, and is chosen by meaning like any other.
//
//   [MUST-FAIL] a general goal whose recall missed: the prose producer is a candidate, described, and the chooser that is
//               shown it does not infer repairPolicy/maintenanceLease.
//   [CONTROL]   a system goal still recalls and chooses its system shapes.
//   [CONTROL]   a goal whose recall already holds an ANSWER_SHAPES member is unchanged (no prose producer added).
//   [CONTROL]   recall unavailable is still the degraded tier; nothing is added when no prose producer is advertised.
//
// Fixture goal from a fresh 5-word draw (draw-words.sh):
//   2026-10-28T19:30:28Z seed=1793215828941561341 words=sarcasm icon proved dislodge overexert
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as sr from "../src/shape-recall";
import { inferGoalTargetDecision } from "../src/goal-target-inference";

const recalledCandidates = sr.recalledCandidates as (...a: unknown[]) => any;
const proseProducerOf = (sr as Record<string, unknown>)["proseProducerOf"] as ((k: ReadonlySet<string> | readonly string[]) => string | null) | undefined;
const row = (name: string, desc: string) => ({ content: `${name}: ${desc}`, summary: `${name}: ${desc}`.slice(0, 300), pointer: { name } });
const GOAL = "How can I dislodge a stuck jar lid without overexerting my wrists? Skip the sarcasm: list the methods that have proved reliable, with an icon for each.";
const INTERNAL = [
  row("maintenanceLease", "produces maintenanceLease; use for managing ongoing maintenance contracts and associated obligations."),
  row("repairPolicy", "produces repairPolicy; use for goals related to live system repair and maintenance activities."),
  row("topologyCoverage", "produces topology coverage data; use for evaluating network topology completeness."),
];
const KNOWN = new Set(["maintenanceLease", "repairPolicy", "topologyCoverage", "llm_completion_dispatch", "llm_completion", "widgetLedger_tally"]);

/** A chooser that picks by meaning from what it is shown: the prose producer when it is offered for a general question,
 *  else the first internal shape (what the live chooser did with no answer producer in the list). */
function meaningChooser(prompts: string[]) {
  return async (p: string) => {
    prompts.push(p);
    const offeredProse = /llm_completion_dispatch/.test(p.slice(p.indexOf("GOAL:")));
    return JSON.stringify({ target_shapes: offeredProse ? ["llm_completion_dispatch"] : ["repairPolicy", "maintenanceLease"], confidence: 0.8, alternatives: [] });
  };
}

describe("the prose producer joins the recall candidates when no answer shape was recalled", () => {
  it("[MUST-FAIL] a general goal whose recall missed gets the prose producer as a described candidate", () => {
    expect(typeof proseProducerOf).toBe("function");
    const c = recalledCandidates(INTERNAL, [], KNOWN);
    expect(c.tier).toBe("recall");
    expect(c.shapes).toContain("llm_completion_dispatch");
    expect(c.shapes.slice(0, 3)).toEqual(["maintenanceLease", "repairPolicy", "topologyCoverage"]);
    expect(c.fromProse).toEqual(["llm_completion_dispatch"]);
    expect(c.catalog["llm_completion_dispatch"].description).toContain("answers the goal directly in text");
  });

  it("[MUST-FAIL] the chooser shown those candidates does not infer repairPolicy or maintenanceLease", async () => {
    const c = recalledCandidates(INTERNAL, [], KNOWN);
    const prompts: string[] = [];
    const d = await inferGoalTargetDecision(GOAL, [...KNOWN], { complete: meaningChooser(prompts), maxTargetShapes: 6, shapeCatalog: c.catalog, promptVocabulary: c.shapes });
    expect(d.shapes).toEqual(["llm_completion_dispatch"]);
    expect(d.shapes).not.toContain("repairPolicy");
    expect(d.shapes).not.toContain("maintenanceLease");
  });

  it("[CONTROL] a system goal still recalls and chooses its system shapes", async () => {
    const recalled = [row("widgetLedger_tally", "Reads the widget ledger and reports how many widgets it holds in each category.")];
    const c = recalledCandidates(recalled, [], KNOWN);
    expect(c.shapes[0]).toBe("widgetLedger_tally");
    const complete = async () => JSON.stringify({ target_shapes: ["widgetLedger_tally"], confidence: 0.8 });
    const d = await inferGoalTargetDecision("How many widgets does the ledger hold in each category?", [...KNOWN], { complete, maxTargetShapes: 6, shapeCatalog: c.catalog, promptVocabulary: c.shapes });
    expect(d.shapes).toEqual(["widgetLedger_tally"]);
  });

  it("[CONTROL] recall that already holds an ANSWER_SHAPES member is unchanged", () => {
    const withAnswer = recalledCandidates([...INTERNAL, row("llm_completion", "produces LLM completions.")], [], KNOWN);
    expect(withAnswer.shapes).toEqual(["maintenanceLease", "repairPolicy", "topologyCoverage", "llm_completion"]);
    expect(withAnswer.shapes).not.toContain("llm_completion_dispatch");
    // the class's recorded target being an answer shape counts too
    const viaPath = recalledCandidates(INTERNAL, ["llm_completion"], KNOWN);
    expect(viaPath.shapes).not.toContain("llm_completion_dispatch");
  });

  it("[CONTROL] degraded tier and no advertised prose producer: nothing is added", () => {
    expect(recalledCandidates(null, [], KNOWN).tier).toBe("degraded");
    const none = recalledCandidates(INTERNAL, [], new Set(["maintenanceLease", "repairPolicy", "topologyCoverage"]));
    expect(none.shapes).toEqual(["maintenanceLease", "repairPolicy", "topologyCoverage"]);
    expect(proseProducerOf!(new Set(["llm_completion"]))).toBe("llm_completion");
    expect(proseProducerOf!(["llm_completion_dispatch", "llm_completion"])).toBe("llm_completion_dispatch");
  });

  it("[WIRING] the prose route reads the same choice", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "goal-target-inference.ts"), "utf-8");
    expect(src).toContain("const _proseTarget = proseProducerOf(knownShapes);");
  });
});
