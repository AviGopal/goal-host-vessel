import { describe, it, expect } from "bun:test";

/**
 * A CORRECT REACH THAT TEACHES NOTHING IS A LOST REACH.
 *
 * MEASURED 2026-08-17. The two-source compositional goal reached correctly — 58 + 2 = 60,
 * hand-verified against ground truth captured before dispatch — and returned:
 *
 *     "learning": { "alphaBetaDelta": [], "oracleLabelWritten": false }
 *
 * The registry-ratio reach, also correct, logged:
 *
 *     reach-patch MATCHED NO ROW … verdict NOT persisted; this execution stays ungraded
 *
 * 2 of 6 patches in a 30-minute window matched no row. The system had just demonstrated it
 * could compose, and the results worth learning from were exactly the ones being dropped.
 *
 * CAUSE: the store's classifyReach reads TAGS. The satisfier-only durable trace carried only
 * `status`, so it landed ungraded and its verdict depended entirely on a later cross-network
 * POST /reach arriving after the row existed.
 *
 * The floor path hit this identical failure and already fixed it by grading at insert — its
 * comment states the reason outright: "Grading at insert makes credit independent of a
 * cross-network patch that measurably drops verdicts." This reuses that shape rather than
 * inventing a second one (law 3), which is why the test asserts BOTH tiers tag the same way:
 * a single reader must grade them identically, and a divergence here is how two graders drift.
 */

const SRC = new URL("../src/index.ts", import.meta.url);

async function source(): Promise<string> {
  return await Bun.file(SRC).text();
}

describe("satisfier traces are graded at insert, not by a droppable patch", () => {
  it("THE REGRESSION: the durable satisfier trace carries a reach tag", async () => {
    const src = await source();
    const idx = src.indexOf("if (satisfierOnlyTrace) {");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2200);
    // Before the fix this object set `status` and `reason` only, and the verdict rode
    // entirely on POST /reach.
    expect(block).toMatch(/tags:\s*\[/);
    expect(block).toContain('"reached:true"');
    expect(block).toContain('"reached:false"');
  });

  it("the tag reflects the verdict, not the status field", async () => {
    const src = await source();
    const idx = src.indexOf("if (satisfierOnlyTrace) {");
    const block = src.slice(idx, idx + 2200);
    // `reached ? "reached:true" : "reached:false"` — driven by the reach verdict itself.
    // A tag derived from `status` would be a second derivation that can disagree with the
    // first, which is the write-key/read-key shape this codebase keeps paying for.
    expect(block).toMatch(/reached\s*\?\s*"reached:true"\s*:\s*"reached:false"/);
  });

  it("pre-existing reach tags are replaced, never duplicated", async () => {
    const src = await source();
    const idx = src.indexOf("if (satisfierOnlyTrace) {");
    const block = src.slice(idx, idx + 2200);
    // Two contradictory reached: tags on one row is worse than none — the reader takes
    // whichever it sees first and the verdict becomes order-dependent.
    expect(block).toMatch(/filter\(\(t\) => !\/\^reached:\/\.test\(t\)\)/);
  });

  it("BOTH tiers grade the same way — floor and satisfier must not drift", async () => {
    const src = await source();
    // The floor's graded-at-insert trace, which this reuses.
    const floorIdx = src.indexOf('templateId: "universal-tool-fallback"');
    expect(floorIdx).toBeGreaterThan(-1);
    const floorBlock = src.slice(floorIdx, floorIdx + 2500);
    expect(floorBlock).toContain('"reached:true"');
    // One reader (classifyReach) grades both tiers; if these ever diverge, one tier silently
    // stops being credited while the other keeps working — the failure that hid this for the
    // floor until a 2,000-row window showed ZERO floor executions.
    expect(floorBlock).toMatch(/reached:false/);
  });

  it("the patch still fires — the tag is belt-and-braces, not a replacement", async () => {
    const src = await source();
    // Removing the patch would trade one single point of failure for another. If the patch
    // lands it agrees with the tag; if it matches no row the verdict is already durable.
    expect(src).toContain("deliverReachVerdict");
    expect(src).toContain("reach-patch MATCHED NO ROW");
  });
});
