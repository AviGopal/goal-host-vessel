// A MINTED COMPOSITE'S DELIVERABLE SHAPE IS A RECALL CANDIDATE. When a paraphrase of a goal the system already composed
// for recalls that composite's deliverable shape, the shape must stay in the recalled set: that is how the walk reuses the
// learned pathway instead of minting a duplicate. A filter that drops `composedDeliverable_*` names from `recalled`
// implements the defect rather than fixing it.
import { describe, expect, it } from "bun:test";
import { recalledCandidates } from "../src/shape-recall";

const row = (name: string, desc: string) => ({ content: `${name}: ${desc}` });
const COMPOSITE = "composedDeliverable_produce_a_tide_pool_species_census_card_";

describe("recalledCandidates: minted composites", () => {
  it("[MUST-FAIL] a recalled, advertised minted composite deliverable shape is returned as a recall candidate", () => {
    const c = recalledCandidates(
      [row(COMPOSITE, "A census card of the species found in a tide pool."), row("fossilRankReport", "Ranks fossils.")],
      [],
      new Set([COMPOSITE, "fossilRankReport"]),
    );
    expect(c.tier).toBe("recall");
    expect(c.recalled).toEqual([COMPOSITE, "fossilRankReport"]);
    expect(c.shapes).toEqual([COMPOSITE, "fossilRankReport"]);
    expect(c.catalog[COMPOSITE].description).toBe("A census card of the species found in a tide pool.");
  });
  it("[CONTROL] non-composite recall is unchanged: recalled keeps recall order, goal-path shapes follow in shapes only", () => {
    const c = recalledCandidates([row("a", "A."), row("b", "B.")], ["c", "a"], new Set(["a", "b", "c"]));
    expect(c.recalled).toEqual(["a", "b"]);
    expect(c.shapes).toEqual(["a", "b", "c"]);
    expect(c.fromGoalPaths).toEqual(["c"]);
  });
});
