// I-T STRUCTURAL (piece 3): TARGET CANDIDATES ARE RECALLED BY MEANING, BOUNDED BY k. The chooser used to be shown every
// advertised shape (names, then descriptions): O(shapes) per call. Candidates are now the top-k shapes concept-db's shape
// index recalls for the goal, unioned with the goal class's recorded target shapes; recall unavailable is a named,
// recorded DEGRADED tier.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as sr from "../src/shape-recall";
import { inferGoalTargetDecision } from "../src/goal-target-inference";

const recalledCandidates = (sr as unknown as { recalledCandidates?: (...a: unknown[]) => any }).recalledCandidates ?? (() => ({ tier: "degraded", catalog: {}, shapes: [], recalled: [], fromGoalPaths: [] }));
const row = (name: string, desc: string) => ({ content: `${name}: ${desc}`, summary: `${name}: ${desc}`.slice(0, 300), pointer: { name } });
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

describe("recalledCandidates", () => {
  it("[MUST-FAIL] recalled rows become the bounded catalog, described; a non-advertised recalled shape is left out", () => {
    const c = recalledCandidates([row("widgetLedger_tally", "Counts widgets per category."), row("ghost_shape", "Not advertised here.")], [], new Set(["widgetLedger_tally", "shellResult"]));
    expect(c.tier).toBe("recall");
    expect(c.shapes).toEqual(["widgetLedger_tally"]);
    expect(c.catalog["widgetLedger_tally"].description).toBe("Counts widgets per category.");
  });
  it("[MUST-FAIL] the goal class's recorded target shapes join the candidates (the learned prior), after the recalled ones", () => {
    const c = recalledCandidates([row("a", "A.")], ["b", "a"], new Set(["a", "b"]));
    expect(c.shapes).toEqual(["a", "b"]);
    expect(c.fromGoalPaths).toEqual(["b"]);
  });
  it("[CONTROL] recall unavailable (null) or empty: the named DEGRADED tier, with its reason", () => {
    expect(recalledCandidates(null, [], new Set(["a"])).tier).toBe("degraded");
    const e = recalledCandidates([], [], new Set(["a"]));
    expect(e.tier).toBe("degraded");
    expect(e.reason).toContain("no candidates");
  });
});

describe("the chooser is shown the BOUNDED candidates, whatever the registry size", () => {
  const big = Array.from({ length: 4000 }, (_, i) => `shape_${i}`);
  const known = ["widgetLedger_tally", "widgetLedger_digest", "shellResult", ...big];
  const goal = "How many widgets does the ledger hold in each category?";
  async function promptSize(vocab: string[], useRecall: boolean) {
    const prompts: string[] = [];
    const complete = async (p: string) => { prompts.push(p); return JSON.stringify({ target_shapes: ["widgetLedger_tally"], confidence: 0.8 }); };
    const c = recalledCandidates([row("widgetLedger_tally", "Reads the widget ledger and reports how many widgets it holds in each category."), row("widgetLedger_digest", "Summarises recent activity.")], [], new Set(vocab));
    const d = await inferGoalTargetDecision(goal, vocab, { complete, maxTargetShapes: 6, ...(useRecall ? { shapeCatalog: c.catalog, promptVocabulary: c.shapes } : {}) });
    return { chars: Math.max(0, ...prompts.map((p) => p.length)), d, prompts };
  }
  it("[SCALE] 10x the registry: the recalled prompt stays FLAT (bounded by k), and the right target is still chosen", async () => {
    const small = await promptSize(known.slice(0, 400), true);
    const huge = await promptSize(known, true);
    expect(huge.chars).toBeLessThan(small.chars * 1.2);
    expect(huge.d.shapes[0]).toBe("widgetLedger_tally");
    for (const p of huge.prompts) expect(p).toContain("Reads the widget ledger and reports how many widgets it holds in each category.");
  });
  it("[CONTROL] without recall (degraded tier) the prompt grows with the registry (today's behaviour, named)", async () => {
    const small = await promptSize(known.slice(0, 400), false);
    const huge = await promptSize(known, false);
    expect(huge.chars).toBeGreaterThan(small.chars * 5);
  });
});

describe("[WIRING] the call site recalls by meaning with a shaped k, and records the tier", () => {
  it("k is shaped, recall reads the shape index's shared scope, the tier is logged on the decision", () => {
    expect(INDEX).toContain('const _recallK = await shapedBudget("shape_recall_k", 12, 3, 40);');
    expect(INDEX).toContain('await recallConceptRows(goal, _recallK, 10_000, { shape: "shape_description", include_global: true });');
    expect(INDEX).toContain('...(_cands.tier === "recall" ? { shapeCatalog: _cands.catalog, promptVocabulary: _cands.shapes } : {}),');
    expect(INDEX).toContain("recall_tier: _cands.tier, chooser_tier: decision.chooser_tier ?? null");
    expect(INDEX).toContain("shape recall tier=${_cands.tier}");
  });
});
