// A GAP INVESTIGATION IS GRADED BY ITS PRODUCT ON THE GAP (CHANGE-35, Class A).
//
// RUN 0 (2026-10-16): 7 of 17 goals were "investigate (and decompose) gap X"; every one ended ungraded (the citation
// oracle is deliberately not applicable to them since f031f26), and none wrote anything to gap X. Now the investigation's
// product is the gap's DECOMPOSITION (development-vessel's existing decomposeGap, advertised as gapDecomposition), the
// builders send it structured, a text-only goal falls back to a deterministic route, and this oracle reads gap X after.
//
//   [MUST-FAIL] a run whose gapDecomposition names steps the gap store holds as X's children: REACHED (deterministic).
//   [MUST-FAIL] a text-only "investigate and decompose gap X: …" targets gapDecomposition (the fallback route).
//   [CONTROL]   a run that wrote nothing onto X: NOT reached (deterministic, not an abstain).
//   [CONTROL]   X already decomposed: rewriting its existing steps creates none, NOT reached (only `created` counts).
//   [CONTROL]   an investigated_at-only change (stamped at dispatch) is never evidence: NOT reached.
//   [CONTROL]   steps the store does not hold as X's children: NOT reached; an unreadable store decides nothing.
//   [CONTROL]   wiring: the walk binds decompose_gap_id (structured first, text fallback) and skips arg synthesis; the
//               oracle sits above the hollow-walklog cap; the abstain text no longer cites gap investigations.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { inferGoalTargetDecision } from "../src/goal-target-inference";

const GI = (await import("../src/gap-investigation-outcome").catch(() => ({}))) as Record<string, any>;
const X = "gap-under-investigation";
const product = (created: string[], gap = X, children: string[] = created) => [{ id: "imp-1", shape: "gapDecomposition", content: { body: { ok: children.length > 0, gap_id: gap, children, created, reason: "wrote steps" } } }];
const store = (rows: Record<string, { parent?: string; investigated_at?: string }>) => ({
  readGap: async (id: string) => (rows[id] ? { id, classification_metadata: { ...(rows[id]!.parent ? { parent_gap_id: rows[id]!.parent } : {}), ...(rows[id]!.investigated_at ? { investigated_at: rows[id]!.investigated_at } : {}) } } : null),
});
const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("a gap investigation is graded by its product", () => {
  it("[MUST-FAIL] confirmed child steps of X: reached", async () => {
    expect(typeof GI["verifyGapInvestigationOutcome"]).toBe("function");
    const v = await GI["verifyGapInvestigationOutcome"](X, product(["step-1", "step-2"]), store({ "step-1": { parent: X }, "step-2": { parent: X } }));
    expect(v).toMatchObject({ reached: true, deterministic: true });
    expect(v.reason).toContain("2 child step(s)");
  });

  it("[MUST-FAIL] a text-only investigate-and-decompose goal targets gapDecomposition", async () => {
    const d = await inferGoalTargetDecision(`investigate and decompose gap ${X}: the lane re-picks fixed gaps`, ["gapDecomposition", "webSearchResult", "fileEditResult"],
      { complete: async () => JSON.stringify({ target_shapes: ["webSearchResult"] }) });
    expect(d.shapes).toEqual(["gapDecomposition"]);
  });

  it("[CONTROL] nothing written onto X: not reached, deterministic", async () => {
    const v = await GI["verifyGapInvestigationOutcome"](X, [], store({}));
    expect(v).toMatchObject({ reached: false, deterministic: true });
    expect(v.reason).toContain("gap-investigation-no-product");
    const v2 = await GI["verifyGapInvestigationOutcome"](X, product([]), store({}));
    expect(v2.reached).toBe(false);
  });

  it("[CONTROL] X already decomposed: a run that rewrites its existing steps and creates none is NOT reached", async () => {
    const v = await GI["verifyGapInvestigationOutcome"](X, product([], X, [`${X}-step-1`, `${X}-step-2`]), store({ [`${X}-step-1`]: { parent: X }, [`${X}-step-2`]: { parent: X } }));
    expect(v).toMatchObject({ reached: false, deterministic: true });
    expect(v.reason).toContain("created no new step");
  });

  it("[CONTROL] investigated_at alone is never evidence", async () => {
    // the gap row carries investigated_at (stamped at dispatch), but the run produced no decomposition
    const v = await GI["verifyGapInvestigationOutcome"](X, [{ id: "i", shape: "substrateGap", content: { gaps: [{ id: X, classification_metadata: { investigated_at: "2026-10-16T09:00:00Z" } }] } }], store({ [X]: { investigated_at: "2026-10-16T09:00:00Z" } }));
    expect(v.reached).toBe(false);
  });

  it("[CONTROL] unconfirmed steps are not reached; an unreadable store decides nothing", async () => {
    const v = await GI["verifyGapInvestigationOutcome"](X, product(["ghost-1"]), store({ "ghost-1": { parent: "some-other-gap" } }));
    expect(v).toMatchObject({ reached: false, deterministic: true });
    expect(v.reason).toContain("gap-investigation-unconfirmed");
    const v2 = await GI["verifyGapInvestigationOutcome"](X, product(["step-1"]), { readGap: async () => { throw new Error("down"); } });
    expect(v2).toBeNull();
    const v3 = await GI["verifyGapInvestigationOutcome"](X, product(["step-1"], "another-gap"), store({}));
    expect(v3.reached).toBe(false);
  });

  it("[CONTROL] wiring: the walk binds the gap, the oracle sits above the hollow cap, the abstain text is fixed", () => {
    expect(SRC).toContain('} else if (shape === "gapDecomposition" && (typeof opts.variables?.["decompose_gap_id"] === "string" || !gapIdOfGoalText(goal).startsWith("route-edit-"))) {');
    expect(SRC).toContain('deterministicCommand = "gap-decompose";');
    const oracle = SRC.indexOf("const gi = await verifyGapInvestigationOutcome(");
    const cap = SRC.indexOf("// HOLLOW-WALKLOG CAP (gap hollow-green-llm-judge-overrides-all-hollow-walklog)");
    expect(oracle).toBeGreaterThan(0);
    expect(oracle).toBeLessThan(cap);
    expect(SRC).not.toContain("(e.g. a gap investigation), so there is no citation to observe");
  });
});
