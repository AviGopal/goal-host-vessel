import { describe, it, expect } from "bun:test";

/**
 * BOTH HALVES MUST MOVE, AND THE DIRECTION MUST NOT.
 *
 * Wiring per-edge evidence into selection needed two changes that are individually inert:
 *   - the walk must REQUEST scores (the store computes composition_score only on request);
 *   - the walk must READ them as an object (it read them through a number guard, so the field
 *     always evaluated to undefined).
 * Fixing one alone changes nothing observable — the same trap as a corrected URL with an
 * uncorrected response key, which this session hit at five separate boundaries.
 *
 * And the direction must NOT move. `mode:"candidates_with_scores"` also forces the query to
 * FORWARD, so obtaining scores by switching the mode would silently invert the walk's backward
 * query and return the wrong candidates. That is why the store gained an `include_scores` flag
 * orthogonal to direction.
 */

const SRC = new URL("../src/index.ts", import.meta.url);
const src = async () => await Bun.file(SRC).text();

describe("selection wiring — the walk asks for edge evidence", () => {
  it("every discover-by-shapes request opts into scores", async () => {
    const s = await src();
    const bodies = [...s.matchAll(/JSON\.stringify\(\{ required_shapes:[^\n]*?\}\)/g)].map((m) => m[0]);
    expect(bodies.length).toBeGreaterThanOrEqual(5);
    for (const b of bodies) expect(b).toContain("include_scores: true");
  });

  it("THE TRAP: no request switched to candidates_with_scores", async () => {
    const s = await src();
    // That mode forces queryMode='forward'. The walk runs a backward query too; converting it
    // would return producers instead of consumers while looking like a scoring upgrade.
    expect(s).not.toContain('mode: "candidates_with_scores"');
  });

  it("the query directions are unchanged: 4 forward, 1 backward", async () => {
    const s = await src();
    const modes = [...s.matchAll(/mode: "(forward|backward)"/g)].map((m) => m[1]);
    expect(modes.filter((m) => m === "forward").length).toBe(4);
    expect(modes.filter((m) => m === "backward").length).toBe(1);
  });
});

describe("selection wiring — the walk reads edge evidence as an object", () => {
  it("THE REGRESSION: composition_score is no longer read through the number guard", async () => {
    const s = await src();
    // It used to sit in the `??` chain behind numOr(), which requires typeof v === "number",
    // so an object always yielded undefined and edge evidence could never reach a pick.
    const idx = s.indexOf("const globalScore = numOr(");
    expect(idx).toBeGreaterThan(-1);
    const line = s.slice(idx, s.indexOf("\n", idx));
    expect(line).not.toContain("composition_score");
  });

  it("it is read as EdgeEvidence and passed to the blend", async () => {
    const s = await src();
    expect(s).toContain("x.composition_score as EdgeEvidence");
    expect(s).toMatch(/const sampledScore = blendEdgeScore\(/);
  });
});
