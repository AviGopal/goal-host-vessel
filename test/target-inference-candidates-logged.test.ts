// THE INFERENCE TAP NAMES THE CANDIDATES THE TARGET WAS CHOSEN AMONG.
//
// Refs gap target-inference-picks-the-read-shape-and-a-different-store-write-for-a-goal-that-only-persists-content-it-supplies.
// The tap line logged the chosen shapes, the alternatives and the tiers, but not the candidate set. A wrong pick could not
// be told apart from a pick whose right target was never a candidate. With a shape catalog (the recall tier) the line now
// carries candidate_count and candidate_shapes (every judged shape, bounded). Without a catalog (the degraded tier) there
// are no candidates and the line is byte-identical to before, so the verdict-diff goldens (all degraded) do not move.
//
//   [MUST-FAIL] a catalog decision yields candidate_count + candidate_shapes, including the catalog shape not chosen
//   [MUST-FAIL] the tap in index.ts spreads the candidate fields into its JSON
//   [MUST-FAIL] the list is bounded
//   [CONTROL]   a decision with no catalog adds no field (the degraded-tier line is unchanged)
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-30T04:19:46Z seed=1793333986114576087
// words=goldmine overhear breeder entering astute
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as GTI from "../src/goal-target-inference";

const G = GTI as Record<string, any>;
const fields = (d: unknown) => (G["inferenceCandidateFields"] ? G["inferenceCandidateFields"](d) : { absent: true });
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

const CATALOG = {
  goldmine_survey: { description: "Surveys a goldmine and lists the seams it found." },
  breeder_register: { description: "Records a breeder's entry in the register." },
  astute_notice: { description: "Posts a short notice for the astute team." },
};
const NAMES = Object.keys(CATALOG);
const GOAL = "Survey the goldmine and list the seams it found while entering nothing else.";
const complete = async () => JSON.stringify({ target_shapes: ["goldmine_survey"], confidence: 0.8, residual: "" });

describe("the candidate fields", () => {
  it("[MUST-FAIL] a catalog decision yields candidate_count and candidate_shapes, including a catalog shape not chosen", async () => {
    const d = await GTI.inferGoalTargetDecision(GOAL, NAMES, { shapeCatalog: CATALOG, complete });
    const f = fields(d);
    expect(f.candidate_count).toBe(d.candidates!.length);
    expect(f.candidate_count).toBeGreaterThanOrEqual(3);
    expect(f.candidate_shapes).toEqual(expect.arrayContaining(NAMES));
    expect(d.shapes).not.toContain("breeder_register");
  });
  it("[MUST-FAIL] the list is bounded", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ shape: `overhear_${i}`, valid: i % 2 === 0, reason: "" }));
    const f = fields({ candidates: many });
    expect(f.candidate_count).toBe(60);
    expect(f.candidate_shapes).toHaveLength(40);
  });
  it("[MUST-FAIL] the tap in index.ts spreads the candidate fields into its JSON", () => {
    expect(SRC.includes("chooser_tier: decision.chooser_tier ?? null, ...inferenceCandidateFields(decision) }),")).toBe(true);
  });
  it("[CONTROL] no catalog: no candidates, no field added (the degraded-tier line is unchanged)", async () => {
    const d = await GTI.inferGoalTargetDecision(GOAL, NAMES, { complete });
    expect(d.candidates).toBeUndefined();
    const line = JSON.stringify({ goal_hash: "x", inferred_target_shapes: d.shapes, ...(G["inferenceCandidateFields"] ? G["inferenceCandidateFields"](d) : {}) });
    expect(line).toBe(JSON.stringify({ goal_hash: "x", inferred_target_shapes: d.shapes }));
  });
});
