// A PARAPHRASED GOAL RUNS THE TEMPLATE THE RIBOSOME MINTED FROM THE FIRST RUN, NOT THE SATISFIER.
//
// Gap a-minted-template-is-never-selected-for-a-paraphrased-goal-because-pathway-reuse-keys-on-the-exact-goal-hash-or-
// count-gated-shape-cover-and-satisfiers-always-win. The composition-preference probe (index.ts, before the satisfier
// shortcut) now asks minted-cover.ts for a ribosome-extracted candidate covering EVERY missing target, executable now,
// and slot-level by the instance-value lint; found, the satisfier is skipped (no intermediate decline) and the next pick
// takes it inside the feasible set. Pathway-reuse counters (pathwayReusePolicy) are not touched.
//
//   [MUST-FAIL] a paraphrased remember goal (one missing target, memoryNote_write) selects the minted slot-level template
//   [MUST-FAIL] index.ts runs the probe before the satisfier for a single missing target, and the pick takes it first
//   [CONTROL]   a lint-flagged minted template is never picked (it would replay its source record); an unreadable one neither
//   [MUST-FAIL] each refusal is named: instance values, or an unreadable template
//   [CONTROL]   no cover, unbound inputs, a non-learned producer or an excluded id: no pick (the walk is as before), and
//               with no minted pick the exact-goal pathway reuse runs as before
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-30T04:44:14Z seed=1793335454128226053
// words=unnamed audibly pointing shove unethical
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const M = (await import("../src/minted-cover").catch(() => ({}))) as Record<string, any>;
const cover = async (...a: unknown[]): Promise<{ pick: string | null; refused: Array<{ id: string; why: string }> }> =>
  M["mintedCover"] ? M["mintedCover"](...a) : { pick: null, refused: [] };
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

const SLOT_LEVEL = { tasks: [
  { id: "s1", resolver: "memoryNote_write", outputShapes: ["memoryNote_write"], config: { type: "memoryNote_write", title: "{{impulse:note_title}}", body: "{{goal}}" } },
  { id: "s1-read-back", resolver: "memoryNote", outputShapes: ["memoryNote"], config: { type: "memoryNote" } },
] };
const INSTANCE = { tasks: [
  { id: "s1", resolver: "memoryNote_write", outputShapes: ["memoryNote_write"], config: { type: "memoryNote_write", title: "Unnamed shove", body: "remember the unethical pointing", dispatch_id: "1f2e3d4c-0000-4000-8000-00000000abcd" } },
] };
const recs = [
  { id: "satisfier:memoryNote_write", inputShapes: [], outputShapes: ["memoryNote_write"] },
  { id: "activity:⟨learned-composition-memorynote-write⟩", inputShapes: [], outputShapes: ["memoryNote_write", "memoryNote"] },
];
const store = (m: Record<string, unknown>) => async (id: string) => (id in m ? m[id] : null);
const none = () => false;

describe("the minted cover before the satisfier", () => {
  it("[MUST-FAIL] a paraphrased remember goal selects the minted slot-level template", async () => {
    // the paraphrase shares no goal hash with the first run: only shape cover finds the template
    const v = await cover(recs, ["memoryNote_write"], new Set<string>(), none, store({ "learned-composition-memorynote-write": SLOT_LEVEL }));
    expect(v.pick).toBe("learned-composition-memorynote-write");
  });
  it("[MUST-FAIL] index.ts probes before the satisfier for one missing target, and the pick takes the cover first", () => {
    expect(SRC.includes('import { mintedCover } from "./minted-cover";')).toBe(true);
    expect(SRC.includes("if (missingForSatisfier.length > 1 || _provenBadSingle || (missingForSatisfier.length > 0 && _prefCompBudget > 0)) {")).toBe(true);
    const probe = SRC.indexOf("const _mcv = await mintedCover(");
    const sat = SRC.indexOf("const satisfiableNow = preferComposition ? undefined");
    expect(probe).toBeGreaterThan(0);
    expect(sat).toBeGreaterThan(probe);
    expect(SRC.includes("preferComposition = _mintedCoverPick !== null || ((missingForSatisfier.length > 1 || _provenBadSingle) &&")).toBe(true);
    const pick0a = SRC.indexOf("const mintedPick = candidates.find((c) => normActivityId(c.id) === _mcId && feasibleProducer(c));");
    expect(pick0a).toBeGreaterThan(sat);
    expect(SRC.indexOf("if (!pick && pathwaySet.size > 0) {", pick0a)).toBeGreaterThan(pick0a);
  });
  it("[CONTROL] a lint-flagged minted template is never picked; an unreadable one neither", async () => {
    expect((await cover(recs, ["memoryNote_write"], new Set<string>(), none, store({ "learned-composition-memorynote-write": INSTANCE }))).pick).toBeNull();
    expect((await cover(recs, ["memoryNote_write"], new Set<string>(), none, store({}))).pick).toBeNull();
  });
  it("[MUST-FAIL] each refusal is named (the walk taps it): instance values, or an unreadable template", async () => {
    expect((await cover(recs, ["memoryNote_write"], new Set<string>(), none, store({ "learned-composition-memorynote-write": INSTANCE }))).refused[0]?.why ?? "").toContain("carries instance values");
    expect((await cover(recs, ["memoryNote_write"], new Set<string>(), none, store({}))).refused[0]?.why ?? "").toBe("template unreadable");
  });
  it("[CONTROL] no cover, unbound inputs, a non-learned producer or an excluded id: no pick", async () => {
    const tpl = store({ "learned-composition-memorynote-write": SLOT_LEVEL, "learned-pointing": SLOT_LEVEL });
    expect((await cover(recs, ["memoryNote_write", "shellResult"], new Set<string>(), none, tpl)).pick).toBeNull();
    expect((await cover([{ id: "learned-pointing", inputShapes: ["shellResult"], outputShapes: ["memoryNote_write"] }], ["memoryNote_write"], new Set<string>(), none, tpl)).pick).toBeNull();
    expect((await cover([{ id: "composed-unnamed", inputShapes: [], outputShapes: ["memoryNote_write"] }], ["memoryNote_write"], new Set<string>(), none, tpl)).pick).toBeNull();
    expect((await cover(recs, ["memoryNote_write"], new Set<string>(), (id: string) => id === "learned-composition-memorynote-write", tpl)).pick).toBeNull();
    expect((await cover(recs, [], new Set<string>(), none, tpl)).pick).toBeNull();
  });
});
