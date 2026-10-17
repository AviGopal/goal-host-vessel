// I-T (a): THE PROSE SHORTCUT LEAVES A COMPOSITION ASK TO THE INFERRER. An explanatory goal that also asks to
// persist its answer must keep its write target: the deterministic prose route returned the prose shape alone.
import { describe, expect, it } from "bun:test";
import { inferGoalTargetDecision } from "../src/goal-target-inference";

const KNOWN = ["llm_completion_dispatch", "memoryNote_write", "concept_write", "shellResult", "fileContent"];
const stub = (shapes: string[]) => {
  const prompts: string[] = [];
  return { prompts, complete: async (p: string) => { prompts.push(p); return JSON.stringify({ target_shapes: shapes, confidence: 0.8 }); } };
};

describe("the prose route and composition asks", () => {
  for (const goal of [
    "Explain how the walk binds data between shapes, and record a memory note summarising it.",
    "Describe what a rhythm impulse is and save the description to a memory note.",
    "Tell me about the ribosome, then capture that explanation as a concept.",
  ]) {
    it(`[MUST-FAIL] the inferrer is consulted and the write is kept — ${goal.slice(0, 50)}…`, async () => {
      const s = stub(["llm_completion_dispatch", goal.includes("concept") ? "concept_write" : "memoryNote_write"]);
      const d = await inferGoalTargetDecision(goal, KNOWN, { complete: s.complete });
      expect(s.prompts.length).toBeGreaterThan(0);
      expect(d.shapes.some((x) => x.endsWith("_write"))).toBe(true);
    });
  }
  it("[CONTROL] a plain explanatory question still takes the prose route without asking the model", async () => {
    const s = stub(["memoryNote_write"]);
    const d = await inferGoalTargetDecision("Explain how the walk binds data between shapes.", KNOWN, { complete: s.complete });
    expect(d.shapes).toEqual(["llm_completion_dispatch"]);
    expect(s.prompts.length).toBe(0);
  });
});
