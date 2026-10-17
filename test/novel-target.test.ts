/**
 * J2b: a goal whose output no existing shape produces is named NOVEL, with a described residual (src/novel-target.ts).
 *
 * WHAT THESE PROVE: with a STUBBED chooser, that the decision carries the chooser's NOVEL answer as given and that no
 * lexical route overrides it, on both registry styles (names only; described catalog). The CROSSED PAIRS are the point:
 *   - words OVERLAP an existing shape's name/description but its production would not satisfy the goal -> the chooser
 *     answers NOVEL -> no target, novel recorded (the lexical fallback, which would pick the overlapping shape, does not);
 *   - NO word overlap, but an existing shape satisfies it -> the chooser picks it -> not novel.
 * Whether a real chooser recognises MEANING is not proved here: that is the live check against real embeddings and a
 * real model (a later piece).
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inferGoalTargetDecision } from "../src/goal-target-inference";
import { parseNovel, NOVEL_OPTION } from "../src/novel-target";
import { UnboundInputs, needsInformationOutcome, questionFor } from "../src/needs-information";

// Opaque registry: names carry no meaning a route could key on.
const CATALOG = {
  widgetLedger_tally: { description: "Counts the widgets recorded in the ledger, per category." },
  xq_7: { description: "Renders a calendar of a team's scheduled maintenance windows." },
  notice_post: { description: "Posts a short notice to the team channel." },
};
const NAMES = Object.keys(CATALOG);

// Overlaps widgetLedger_tally's words (widget, ledger, count) but needs an output nothing produces (a forecast).
const OVERLAP_NOVEL_GOAL = "Forecast how many widgets the ledger will count next quarter from the supplier contracts.";
// No word overlap with xq_7's name or description, but its production satisfies the goal.
const NO_OVERLAP_EXISTING_GOAL = "When are the upkeep slots for the platform crew?";

const NOVEL_ANSWER = JSON.stringify({ target_shapes: [], novel: { residual: "a forecast of future widget counts derived from supplier contracts", closest: "widgetLedger_tally", why_not: "it counts recorded widgets; it does not forecast" } });
const chooser = (answer: string) => {
  const prompts: string[] = [];
  return { prompts, complete: async (p: string) => { prompts.push(p); return answer; } };
};

describe("J2b parse", () => {
  it("[UNIT] a residual is required; closest is kept only when it names a candidate; text is bounded", () => {
    const cands = new Set(NAMES);
    expect(parseNovel({ novel: { residual: "" } }, cands)).toBeNull();
    expect(parseNovel({ target_shapes: ["x"] }, cands)).toBeNull();
    expect(parseNovel({ novel: { residual: "r", closest: "not_a_shape", why_not: "w" } }, cands)).toEqual({ residual: "r", closest: null });
    expect(parseNovel({ novel: { residual: "r", closest: "xq_7", why_not: "w" } }, cands)).toEqual({ residual: "r", closest: { shape: "xq_7", why_not: "w" } });
    expect(parseNovel({ novel: { residual: "x".repeat(1000) } }, cands)!.residual.length).toBe(400);
  });
});

for (const style of ["names-only", "described"] as const) {
  const opts = (complete: (p: string) => Promise<string>) => (style === "described" ? { complete, shapeCatalog: CATALOG } : { complete });
  describe(`J2b crossed pair (${style} registry)`, () => {
    it("[MF] overlapping words, no producing shape: the chooser's NOVEL answer is carried, no target is forced, the overlapping shape is NOT chosen", async () => {
      const c = chooser(NOVEL_ANSWER);
      const d = await inferGoalTargetDecision(OVERLAP_NOVEL_GOAL, NAMES, opts(c.complete));
      expect(d.shapes).toEqual([]);
      expect(d.novel?.residual).toContain("forecast");
      expect(d.novel?.closest).toEqual({ shape: "widgetLedger_tally", why_not: "it counts recorded widgets; it does not forecast" });
    });
    it("[CROSSED CONTROL] no word overlap, an existing shape satisfies it: the chooser picks it and nothing is novel", async () => {
      const c = chooser(JSON.stringify({ target_shapes: ["xq_7"], confidence: 0.8 }));
      const d = await inferGoalTargetDecision(NO_OVERLAP_EXISTING_GOAL, NAMES, opts(c.complete));
      expect(d.shapes).toEqual(["xq_7"]);
      expect(d.novel).toBeUndefined();
    });
    it("[PROMPT] the chooser is offered the NOVEL option, so it never has to force a wrong shape", async () => {
      const c = chooser(NOVEL_ANSWER);
      await inferGoalTargetDecision(OVERLAP_NOVEL_GOAL, NAMES, opts(c.complete));
      expect(c.prompts.length).toBeGreaterThan(0);
      expect(c.prompts.every((p) => p.includes(NOVEL_OPTION.trim().slice(0, 60)))).toBe(true);
    });
  });
}

describe("J2b: the lexical fallback still fills a target when the chooser did NOT say novel (described registry)", () => {
  it("[CONTROL] the chooser proposes only an invalid shape and no residual: the fallback tier picks by the catalog, as before", async () => {
    const c = chooser(JSON.stringify({ target_shapes: ["no_such_shape"] }));
    const d = await inferGoalTargetDecision("Post a short notice to the team channel about the outage.", NAMES, { complete: c.complete, shapeCatalog: CATALOG });
    expect(d.novel).toBeUndefined();
    expect(d.shapes).toEqual(["notice_post"]);
    expect(d.chooser_tier).toBe("fallback");
  });
});

describe("J2b outcome", () => {
  const novel = { residual: "a forecast of future widget counts", closest: { shape: "widgetLedger_tally", why_not: "it counts; it does not forecast" } };
  it("[MF] a novel decision on a dispatch that did not reach ends needs_information/novel_target with the residual", () => {
    const rec = new UnboundInputs();
    rec.noteNovel(novel);
    expect(needsInformationOutcome(rec, false)).toEqual({ kind: "needs_information", reason: "novel_target", missing: [], residual: novel });
    expect(questionFor(needsInformationOutcome(rec, false)!)).toContain("widgetLedger_tally");
  });
  it("[CONTROL] the same decision on a dispatch that REACHED (a fallback produced it) carries no outcome", () => {
    const rec = new UnboundInputs();
    rec.noteNovel(novel);
    expect(needsInformationOutcome(rec, true)).toBeUndefined();
  });
  it("[UNIT] an unbound required input is the more specific outcome and wins over novel", () => {
    const rec = new UnboundInputs();
    rec.noteNovel(novel);
    rec.noteUnderived("fileContent", ["path"], "pool_bind");
    rec.noteUnderived("fileContent", ["path"], "investigation");
    expect(needsInformationOutcome(rec, false)?.reason).toBe("unbound_input");
  });
});

describe("J2b wiring (index.ts)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
  it("[WIRING] a NOVEL decision is recorded for the dispatch; seeding is unchanged, so the fallbacks still run", () => {
    expect(src).toContain("if (decision.novel) {\n        unboundFor(opts.variables?.dispatch_id)?.noteNovel(decision.novel);");
    expect(src).toContain("if (decision.shapes.length > 0) seededOutputShapes = decision.shapes;");
  });
});
