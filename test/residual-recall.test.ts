/**
 * PIECE 5: a need the chosen set leaves unsatisfied is recalled BY MEANING on the chooser's residual (the goal minus what
 * the chosen production explains), once, validity-filtered, then chosen once more. No clause segmentation, no threshold
 * over recall scores. The stubs prove the mechanism; the meaning is the live check's job (piece 6).
 */
import { describe, it, expect } from "bun:test";
import { inferGoalTargetDecision } from "../src/goal-target-inference";

const CAT = {
  ledger_lookup: { description: "Looks up the recorded widget entries in the ledger for a category." },
  notice_post: { description: "Posts a short notice to the team channel." },
  xq_7: { description: "Renders a calendar of a team's scheduled maintenance windows." },
};
// the WHOLE-goal recall shows only the lookup and the calendar; the poster is NOT among the first candidates
const FIRST = { ledger_lookup: CAT.ledger_lookup, xq_7: CAT.xq_7 };
const NAMES = Object.keys(CAT);
const COMPOUND = "Find the widget entries recorded for the gadgets category and then tell the team about them.";

function chooser(first: unknown, second: unknown = { target_shapes: [] }) {
  const prompts: string[] = [];
  return { prompts, complete: async (p: string) => { prompts.push(p); return JSON.stringify(p.includes("ALREADY CHOSEN") ? second : first); } };
}
function recall(map: Record<string, Record<string, { description: string }> | null>) {
  const asked: string[] = [];
  return { asked, fn: async (text: string) => { asked.push(text); return map[text] ?? null; } };
}

describe("residual recall (piece 5)", () => {
  it("[MF] the second need's producer is NOT in the whole-goal candidates but IS recalled for the residual: it is chosen", async () => {
    const c = chooser({ target_shapes: ["ledger_lookup"], confidence: 0.8, residual: "tell the team about the entries" }, { target_shapes: ["notice_post"] });
    const r = recall({ "tell the team about the entries": { notice_post: CAT.notice_post, ledger_lookup: CAT.ledger_lookup } });
    const d = await inferGoalTargetDecision(COMPOUND, NAMES, { complete: c.complete, shapeCatalog: FIRST, recallResidual: r.fn, maxTargetShapes: 6 });
    expect(d.shapes).toEqual(["ledger_lookup", "notice_post"]);
    expect(r.asked).toEqual(["tell the team about the entries"]);
    expect(d.residual).toEqual({ text: "tell the team about the entries", recalled: ["notice_post", "ledger_lookup"], added: ["notice_post"] });
  });
  it("[CONTROL] a single-need goal: empty residual, NO second recall, nothing added", async () => {
    const c = chooser({ target_shapes: ["ledger_lookup"], confidence: 0.9, residual: "" });
    const r = recall({});
    const d = await inferGoalTargetDecision("Find the widget entries recorded for the gadgets category.", NAMES, { complete: c.complete, shapeCatalog: FIRST, recallResidual: r.fn, maxTargetShapes: 6 });
    expect(d.shapes).toEqual(["ledger_lookup"]);
    expect(r.asked).toEqual([]);
    expect(d.residual).toBeUndefined();
  });
  it("[PARAPHRASE] three wordings of the compound goal each reach the second need through their own residual", async () => {
    for (const [g, res] of [
      ["Look up the gadget widgets in the ledger, then announce them to the team.", "announce them to the team"],
      ["After retrieving the ledger's gadget entries, let the crew know what they are.", "let the crew know"],
      ["Which widgets are logged under gadgets? Share the answer with everyone on the team.", "share the answer with the team"],
    ] as const) {
      const c = chooser({ target_shapes: ["ledger_lookup"], residual: res }, { target_shapes: ["notice_post"] });
      const r = recall({ [res]: { notice_post: CAT.notice_post } });
      const d = await inferGoalTargetDecision(g, NAMES, { complete: c.complete, shapeCatalog: FIRST, recallResidual: r.fn, maxTargetShapes: 6 });
      expect(d.shapes).toContain("notice_post");
    }
  });
  it("[HELD-OUT] the residual recall returns only shapes that are not advertised (invalid): nothing is added, nothing is asked", async () => {
    const c = chooser({ target_shapes: ["ledger_lookup"], residual: "tell the team" }, { target_shapes: ["ghost_shape"] });
    const r = recall({ "tell the team": { ghost_shape: { description: "Posts somewhere." } } });
    const d = await inferGoalTargetDecision(COMPOUND, NAMES, { complete: c.complete, shapeCatalog: FIRST, recallResidual: r.fn, maxTargetShapes: 6 });
    expect(d.shapes).toEqual(["ledger_lookup"]);
    expect(c.prompts.some((p) => p.includes("ALREADY CHOSEN"))).toBe(false);
  });
  it("[CONTROL] recall unavailable (null) for the residual: the chosen set stands, the residual is recorded", async () => {
    const c = chooser({ target_shapes: ["ledger_lookup"], residual: "tell the team" });
    const d = await inferGoalTargetDecision(COMPOUND, NAMES, { complete: c.complete, shapeCatalog: FIRST, recallResidual: async () => null, maxTargetShapes: 6 });
    expect(d.shapes).toEqual(["ledger_lookup"]);
    expect(d.residual?.added).toEqual([]);
  });
  it("[PROMPT] every chooser prompt asks for the residual (no keyword rule)", async () => {
    const c = chooser({ target_shapes: ["ledger_lookup"], residual: "" });
    await inferGoalTargetDecision(COMPOUND, NAMES, { complete: c.complete, shapeCatalog: FIRST, recallResidual: async () => null });
    expect(c.prompts.length).toBeGreaterThan(0);
    expect(c.prompts.every((p) => p.includes('"residual"'))).toBe(true);
  });
});
