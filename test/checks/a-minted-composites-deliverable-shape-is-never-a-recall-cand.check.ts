import { describe, it, expect } from "bun:test";
import * as shapeRecall from "../../src/shape-recall";

describe("recalledCandidates duplicate-mint guard", () => {
  it("should not recall an already known, minted composite deliverable shape", () => {
    const goalPathShapes = [];
    const known = new Set(["composedDeliverable_produce_a_tide_pool_species_census_card_"]);
    const rows: shapeRecall.RecalledRow[] = [
      {
        content: "composedDeliverable_produce_a_tide_pool_species_census_card_: produces a census card for tide pool species",
      },
      {
        content: "poolImpulse: triggers analysis of tide pools",
      },
      {
        content: "fossilRankReport: reports the rank of fossils",
      },
    ];

    // This test expects recalledCandidates to NOT include 'composedDeliverable_produce_a_tide_pool_species_census_card_'
    // because it's already in the 'known' set, simulating the duplicate-mint guard.
    // The defect causes it to be recalled anyway.
    const result = shapeRecall.recalledCandidates(rows, goalPathShapes, known);

    expect(result.recalled).not.toContain("composedDeliverable_produce_a_tide_pool_species_census_card_");
  });
});
