import { describe, it, expect } from "bun:test";
import { inferGoalTargetDecision } from "../src/goal-target-inference";

/**
 * A DETERMINISTIC SHORTCUT IS A CANDIDATE IN THE DESCRIBED-PRODUCERS CHOICE, NOT AN EARLY ANSWER (B1).
 *
 * The aggregate / count / extract shortcuts returned ["shellResult"] @0.6, and the prose shortcut returned the prose
 * producer @0.7, BEFORE the chooser saw the advertised vocabulary. So a natural-language read goal whose data an
 * advertised producer holds went to a shell that invents endpoints, or to a completion with no data, even with that
 * producer in recall. Expected, with a shape catalog (the CHOICE: VALIDITY, then the chooser shown the valid
 * candidates' descriptions) and a scripted chooser:
 *   - [MUST-FAIL] a count/aggregate goal over a store an advertised read lists: the chooser is asked, its read is the
 *     target, and the shortcut's shellResult stays an alternative;
 *   - [MUST-FAIL] a summarise goal over data an advertised read returns: the chooser is asked and chooses the read;
 *   - CONTROL: a goal that genuinely needs a shell still gets shellResult (the chooser picks it among the candidates);
 *   - CONTROL: a goal that names a shape as the object of run/execute keeps the named-shape route, chooser not asked;
 *   - CONTROL: the chooser down (no reply), or choosing nothing listed, returns the shortcut's set as before; and with no
 *     catalog (the CHOICE cannot run) the shortcut returns early as before, chooser not asked.
 * Synthetic registry (invented stores and shapes); no goal text from any probe.
 */
type InferOpts = NonNullable<Parameters<typeof inferGoalTargetDecision>[2]>;
const KNOWN = ["shellResult", "llm_completion_dispatch", "runLedger_list", "changeHistory_read", "test_suite", "widgetNote_write"];
const CATALOG = {
  runLedger_list: { description: "lists the recent executions recorded in the run ledger, each with its status and failure reason" },
  changeHistory_read: { description: "returns the recent change history of a repository: each change's id, author and message" },
  shellResult: { description: "runs one shell command and returns its output" },
  llm_completion_dispatch: { description: "answers the goal directly in text" },
  test_suite: { description: "runs a vessel's test suite and reports pass and fail counts" },
};
/** A scripted chooser: answers `pick(prompt)` and records every prompt it was shown. */
function chooser(pick: (prompt: string) => string[] | null) {
  const prompts: string[] = [];
  const complete = async (p: string): Promise<string | null> => {
    prompts.push(p);
    const s = pick(p);
    return s === null ? null : JSON.stringify({ target_shapes: s, confidence: 0.8, alternatives: [] });
  };
  return { prompts, complete };
}
const infer = (goal: string, opts: Partial<InferOpts>) => inferGoalTargetDecision(goal, KNOWN, { shapeCatalog: CATALOG, ...opts } as InferOpts);

describe("deterministic shortcuts are candidates in the described-producers choice", () => {
  it("[MUST-FAIL] a count over a store an advertised read lists: the read is chosen, shellResult stays an alternative", async () => {
    const c = chooser((p) => (/runLedger_list/.test(p) ? ["runLedger_list"] : ["shellResult"]));
    const d = await infer("How many executions failed in the last hour, and what was the most common failure reason?", { complete: c.complete });
    expect(c.prompts.length).toBeGreaterThan(0);
    expect(d.shapes).toEqual(["runLedger_list"]);
    expect(d.alternatives).toContainEqual(["shellResult"]);
  });

  it("[MUST-FAIL] a summarise goal over data an advertised read returns: the read is chosen, not a completion with no data", async () => {
    const c = chooser((p) => (/changeHistory_read/.test(p) ? ["changeHistory_read", "llm_completion_dispatch"] : ["llm_completion_dispatch"]));
    const d = await infer("Summarise the recent changes to the widget repository in two sentences.", { complete: c.complete });
    expect(c.prompts.length).toBeGreaterThan(0);
    expect(d.shapes).toContain("changeHistory_read");
  });

  it("[CONTROL] a goal that genuinely needs a shell still gets shellResult", async () => {
    const c = chooser(() => ["shellResult"]);
    const d = await infer("Count the .ts files under repos/demo-vessel/src and report the number.", { complete: c.complete });
    expect(d.shapes).toEqual(["shellResult"]);
  });

  it("[CONTROL] a goal that names a shape as the object of run/execute keeps the named-shape route", async () => {
    const c = chooser(() => ["runLedger_list"]);
    const d = await infer("Run the test suite for repos/demo-vessel and report how many tests passed.", { complete: c.complete });
    expect(d.shapes).toEqual(["test_suite"]);
    expect(d.alternatives).toEqual([["shellResult"]]);
    expect(c.prompts.length).toBe(0);
  });

  it("[CONTROL] the chooser down, or choosing nothing listed, returns the shortcut's set; no catalog returns it early", async () => {
    const goal = "How many executions failed in the last hour?";
    const down = chooser(() => null);
    const d1 = await infer(goal, { complete: down.complete });
    expect(d1.shapes).toEqual(["shellResult"]);
    const none = chooser(() => []);
    const d2 = await infer(goal, { complete: none.complete });
    expect(d2.shapes).toEqual(["shellResult"]);
    const noCatalog = chooser(() => ["runLedger_list"]);
    const d3 = await inferGoalTargetDecision(goal, KNOWN, { complete: noCatalog.complete } as InferOpts);
    expect(d3.shapes).toEqual(["shellResult"]);
    expect(d3.confidence).toBe(0.6);
    expect(noCatalog.prompts.length).toBe(0);
  });
});
