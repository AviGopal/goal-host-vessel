// A NEAR-VARIANT OF A REACHED GOAL RUNS THE RECOMMENDED PATHWAY'S BODY AND WALKS ONLY THE DIFFERENCE.
//
// The execution contract's middle tier (first/last-mile adaptation). recommendReachingPath returned the whole pathway,
// but the walk read it only as a tie-break among candidates already feasible AND already advancing a target, so a
// near-variant re-derived: 0 body steps executed. pathway-adapt.ts plans the adaptation once per walk; index.ts merges
// the body's template steps into the candidates above the write door and the lint, takes the next bindable body step,
// tags its trace adapted:<mode> + adapted_pathway:<id>, and leaves exact cover (the ceiling) unchanged.
//
//   [MUST-FAIL] last mile: same body, a different final target -> >= 1 body step executes, the old exit does not
//   [MUST-FAIL] last mile covering none: the body's outputs carried to a different target shape -> last_mile, body runs
//   [MUST-FAIL] first mile: same body, a different entry binding -> no body step until the entry is in the pool, then >= 1
//   [MUST-FAIL] index.ts wiring: plan before the loop, merge above the write door, the 0c pick, the trace tag, the fallback
//   [CONTROL]   exact cover -> mode exact, no body step taken (the ceiling path is as before)
//   [CONTROL]   no pathway, or a satisfier-only pathway -> no plan
//   [CONTROL]   an unreadable template step is skipped with a named reason; all unreadable -> no plan
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-31T07:42:34Z seed=1793432554459930109
// words=rinse strongbox rockfish catatonic silencer
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { id: string; inputShapes: string[]; outputShapes: string[] };
type Plan = { mode: string | null; steps: Step[]; skipped: Array<{ id: string; why: string }> };
const M = (await import("../src/pathway-adapt").catch(() => ({}))) as Record<string, any>;
const plan = async (...a: unknown[]): Promise<Plan> => (M["planAdaptation"] ? M["planAdaptation"](...a) : { mode: null, steps: [], skipped: [] });
const next = (p: Plan, done: (id: string) => boolean, pool: Set<string>): Step | null => (M["nextBodyStep"] ? M["nextBodyStep"](p, done, pool) : null);
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

const TPL: Record<string, unknown> = {
  "learned-rinse-strongbox": { id: "learned-rinse-strongbox", inputShapes: ["strongbox_path"], outputShapes: ["strongbox_listing"], tasks: [] },
  "rockfish-digest": { id: "rockfish-digest", input_shapes: ["strongbox_listing"], output_shapes: ["catalogue_digest"], tasks: [] },
  "silencer-note": { id: "silencer-note", inputShapes: ["catalogue_digest"], outputShapes: ["memoryNote_write"], tasks: [] },
};
const store = (m: Record<string, unknown>) => async (id: string) => (id in m ? m[id] : null);
const PATHWAY = ["activity:⟨learned-rinse-strongbox⟩", "rockfish-digest", "silencer-note"];

// The walk's loop around the module: take the next bindable body step, "execute" it (its outputs enter the pool).
const walkBody = (p: Plan, pool: Set<string>): string[] => {
  const ran: string[] = [];
  for (let i = 0; i < 6; i++) {
    const s = next(p, (id) => ran.includes(id), pool);
    if (!s) break;
    ran.push(s.id);
    for (const o of s.outputShapes) pool.add(o);
  }
  return ran;
};

describe("first/last-mile adaptation of a recommended pathway", () => {
  it("[MUST-FAIL] last mile: same body, a different final target -> >= 1 body step executes, the old exit does not", async () => {
    const pool = new Set(["goal", "strongbox_path"]);
    const p = await plan(PATHWAY, ["catalogue_digest", "chat_post"], pool, store(TPL));
    expect(p.mode).toBe("last_mile");
    const ran = walkBody(p, pool);
    expect(ran.length).toBeGreaterThanOrEqual(1);
    expect(ran).toEqual(["learned-rinse-strongbox", "rockfish-digest"]);
    expect(p.skipped.map((s) => s.id)).toContain("silencer-note");
  });
  it("[MUST-FAIL] last mile, covering none: same body, outputs carried to a different target shape -> last_mile, the body runs", async () => {
    const pool = new Set(["goal", "strongbox_path"]);
    const p = await plan(PATHWAY, ["chat_post"], pool, store(TPL));
    expect(p.mode).toBe("last_mile");
    expect(walkBody(p, pool)).toEqual(["learned-rinse-strongbox", "rockfish-digest"]);
    expect(p.skipped.map((s) => s.id)).toContain("silencer-note");
  });
  it("[MUST-FAIL] first mile: same body, a different entry binding -> no step until the entry is bound, then >= 1", async () => {
    const pool = new Set(["goal", "vault_path"]);
    const p = await plan(PATHWAY, ["memoryNote_write"], pool, store(TPL));
    expect(p.mode).toBe("first_mile");
    expect(walkBody(p, new Set(pool))).toEqual([]);
    pool.add("strongbox_path"); // the ordinary walk produced the entry from this goal's input
    expect(walkBody(p, pool).length).toBeGreaterThanOrEqual(1);
  });
  it("[MUST-FAIL] index.ts wiring: plan before the loop, merge above the write door, the 0c pick, the tag, the fallback", () => {
    expect(SRC.includes('import { planAdaptation, nextBodyStep, type AdaptPlan } from "./pathway-adapt";')).toBe(true);
    const planAt = SRC.indexOf("_adaptPlan = await planAdaptation(opts.preferPathway, [...target], producedShapes,");
    const loop = SRC.indexOf("while (chain.length < MAX_STEPS && !targetMet()) {", planAt);
    expect(planAt).toBeGreaterThan(0);
    expect(loop).toBeGreaterThan(planAt);
    const merge = SRC.indexOf("for (const b of _adaptPlan!.steps) if (!seen.has(b.id)", loop);
    const door = SRC.indexOf('candidates = writeDoorFilter(candidates, (c) => c.outputShapes, changeAdmitted, "template_pick"', loop);
    expect(merge).toBeGreaterThan(loop);
    expect(door).toBeGreaterThan(merge);
    const reuse = SRC.indexOf("if (!pick && pathwaySet.size > 0) {", door);
    const adapted = SRC.indexOf("const _nb = nextBodyStep(_adaptPlan!,", door);
    const genuine = SRC.indexOf("// 1. A GENUINE (non-hollow-scaffold) feasible producer of a target shape.", door);
    expect(adapted).toBeGreaterThan(reuse);
    expect(genuine).toBeGreaterThan(adapted);
    const tags = SRC.indexOf("const _adaptTags = _adaptBody.has(normActivityId(pick.id)) ? [...(opts.tags ?? []), `adapted:${_adaptPlan!.mode}`, `adapted_pathway:${_adaptId}`] : null;", genuine);
    const run = SRC.indexOf("trace = await host.runTemplate(template, bvars, {", tags);
    expect(tags).toBeGreaterThan(genuine);
    expect(run).toBeGreaterThan(tags);
    expect(SRC.indexOf("...(_adaptTags ? { tags: _adaptTags } : {}),", run) - run).toBeGreaterThan(0);
    expect(SRC.indexOf("...(_adaptTags ? { tags: _adaptTags } : {}),", run) - run).toBeLessThan(700);
    expect(SRC.includes("failed (${pickFailures.get(pick.id)}) — excluded; the walk continues as before")).toBe(true);
    expect(SRC.includes("exact cover: the ceiling path, walk unchanged")).toBe(true);
  });
  it("[CONTROL] exact cover -> mode exact, no body step taken (the ceiling path is as before)", async () => {
    const pool = new Set(["goal", "strongbox_path"]);
    const p = await plan(PATHWAY, ["memoryNote_write"], pool, store(TPL));
    expect(p.mode === "exact" || p.mode === null).toBe(true);
    expect(walkBody(p, pool)).toEqual([]);
  });
  it("[CONTROL] no pathway, or a satisfier-only pathway -> no plan", async () => {
    expect((await plan([], ["chat_post"], new Set(["goal"]), store(TPL))).mode).toBeNull();
    expect((await plan(null, ["chat_post"], new Set(["goal"]), store(TPL))).mode).toBeNull();
    expect((await plan(["satisfier:shellResult", "satisfier:memoryNote_write"], ["memoryNote_write", "chat_post"], new Set(["goal"]), store(TPL))).mode).toBeNull();
  });
  it("[CONTROL] an unreadable template step is skipped with a named reason; all unreadable -> no plan", async () => {
    const p = await plan(["ghost-step", ...PATHWAY], ["catalogue_digest", "chat_post"], new Set(["strongbox_path"]), store(TPL));
    const ghost = p.skipped.find((s) => s.id === "ghost-step");
    if (M["planAdaptation"]) expect(ghost?.why).toBe("template unreadable");
    expect(p.steps.map((s) => s.id)).not.toContain("ghost-step");
    expect((await plan(["ghost-step"], ["chat_post"], new Set(["goal"]), store({}))).mode).toBeNull();
  });
});
