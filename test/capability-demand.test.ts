// RECURRING DEMAND (openspec contained-self-development 8.14's "revisit only for shapes with recurring demand"; 2026-10-13): the
// SAME goal, already on the shape's row, failing at least R2's min_runs times since its last reach is demand; a one-off goal, and
// any goal's first demand for a shape, stays born closed.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityDemand, distinctRunsSince, exactFailuresSince } from "../src/capability-demand";

const G = "tabulate the quarry ledger per depot";
describe("capabilityDemand", () => {
  it("MUST-FAIL: a one-off goal (fewer failures than min_runs) is still born closed, and the same goal again writes nothing", () => {
    expect(capabilityDemand({ priorGoals: [], goalKey: G, priorFailures: 0, minRuns: 3 })).toEqual({ skip: false, demandGoals: [G], demanded: false, recurring: false });
    expect(capabilityDemand({ priorGoals: [G], goalKey: G, priorFailures: 2, minRuns: 3 })).toMatchObject({ skip: true, demanded: false });
  });
  it("MUST-FAIL: the same goal recurring >= min_runs times is demand: filed OPEN (a closed row reopens), without duplicating the goal", () => {
    expect(capabilityDemand({ priorGoals: [G], goalKey: G, priorFailures: 3, minRuns: 3 })).toEqual({ skip: false, demandGoals: [G], demanded: true, recurring: true });
  });
  it("MUST-FAIL (1): a recurring-failure goal's FIRST demand for a shape is born closed (8.15): recurring needs the goal already on this shape's row", () => {
    // one goal names a different model-inferred shape each run: each name's first demand is a walk artifact, however often the goal failed
    expect(capabilityDemand({ priorGoals: [], goalKey: G, priorFailures: 5, minRuns: 3 })).toEqual({ skip: false, demandGoals: [G], demanded: false, recurring: false });
    expect(capabilityDemand({ priorGoals: [], goalKey: G, priorFailures: 77, minRuns: 3 })).toEqual({ skip: false, demandGoals: [G], demanded: false, recurring: false });
  });
  it("MUST-FAIL (2)(3): seen + runs >= min_runs is OPEN; seen + runs < min_runs writes nothing", () => {
    expect(capabilityDemand({ priorGoals: [G], goalKey: G, priorFailures: 77, minRuns: 3 })).toEqual({ skip: false, demandGoals: [G], demanded: true, recurring: true });
    expect(capabilityDemand({ priorGoals: ["another goal needing it", G], goalKey: G, priorFailures: 3, minRuns: 3 })).toEqual({ skip: false, demandGoals: ["another goal needing it", G], demanded: true, recurring: true });
    expect(capabilityDemand({ priorGoals: [G], goalKey: G, priorFailures: 2, minRuns: 3 })).toEqual({ skip: true, demandGoals: [G], demanded: false, recurring: false });
    expect(capabilityDemand({ priorGoals: [G], goalKey: G, priorFailures: 0, minRuns: 0 })).toEqual({ skip: true, demandGoals: [G], demanded: false, recurring: false });
  });
  it("MUST-FAIL (4): a second distinct goal is OPEN whatever its own failure count (8.15 unchanged)", () => {
    expect(capabilityDemand({ priorGoals: ["another goal needing it"], goalKey: G, priorFailures: 5, minRuns: 3 })).toEqual({ skip: false, demandGoals: ["another goal needing it", G], demanded: true, recurring: false });
  });
  it("CONTROL: a second distinct goal is demand exactly as before (8.15)", () => {
    expect(capabilityDemand({ priorGoals: ["another goal needing it"], goalKey: G, priorFailures: 0, minRuns: 3 })).toEqual({ skip: false, demandGoals: ["another goal needing it", G], demanded: true, recurring: false });
  });
  it("MUST-FAIL: failures from before the goal's last reach never count", () => {
    const recs = [{ at: "2030-01-01T00:00:00Z" }, { at: "2030-01-02T00:00:00Z" }, { at: "2030-01-03T00:00:00Z" }, { at: "2030-01-05T00:00:00Z" }];
    expect(exactFailuresSince(recs, "2030-01-04T00:00:00Z")).toHaveLength(1);
    expect(exactFailuresSince(recs, "")).toHaveLength(4);
    const since = exactFailuresSince(recs, "2030-01-04T00:00:00Z").length;
    expect(capabilityDemand({ priorGoals: [G], goalKey: G, priorFailures: since, minRuns: 3 })).toMatchObject({ skip: true, demanded: false });
  });
  it("MUST-FAIL (5): runs, not records: 1 run x 3 reasons is ONE run (a one-off stays closed); 3 runs x 1 reason is recurring; mixed counts distinct runs", () => {
    const run = (sec: number, n: number) => Array.from({ length: n }, () => `2030-01-0${sec}T00:00:00.123Z`);
    const one = distinctRunsSince(run(1, 3), "");
    expect(one).toBe(1);
    expect(capabilityDemand({ priorGoals: [G], goalKey: G, priorFailures: one, minRuns: 3 })).toMatchObject({ skip: true, demanded: false });
    const three = distinctRunsSince([...run(1, 1), ...run(2, 1), ...run(3, 1)], "");
    expect(three).toBe(3);
    expect(capabilityDemand({ priorGoals: [G], goalKey: G, priorFailures: three, minRuns: 3 })).toMatchObject({ demanded: true, recurring: true });
    expect(distinctRunsSince([...run(1, 3), ...run(2, 3), ...run(3, 1)], "")).toBe(3);
    expect(distinctRunsSince([...run(1, 3), ...run(2, 2)], "")).toBe(2);
    // the same run's records stamped a few ms apart are still one run; runs before the last reach never count
    expect(distinctRunsSince(["2030-01-01T00:00:00.123Z", "2030-01-01T00:00:00.124Z"], "")).toBe(1);
    expect(distinctRunsSince([...run(1, 3), ...run(5, 3)], "2030-01-04T00:00:00Z")).toBe(1);
    // more runs than the failure-recall window holds are all counted (12 records, 4 runs)
    expect(distinctRunsSince([...run(1, 3), ...run(2, 3), ...run(3, 3), ...run(4, 3)], "")).toBe(4);
  });
  it("structural: fileCapabilityGap counts distinct runs from every recorded stamp (live and reloaded), recall keeps its since-last-reach filter, and min_runs comes from goalDeficiencyPolicy", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(src).toContain("const priorFailures = distinctRunsSince(goalFailureStamps.get(_gh) ?? [], goalLastReachedAt.get(_gh) ?? \"\");");
    expect(src).toContain("noteGoalFailureStamp(rec.hash, rec.at);");
    expect(src).toContain("noteGoalFailureStamp(o.hash, o.at ?? \"\");");
    expect(src).toContain("capabilityDemand({ priorGoals, goalKey, priorFailures, minRuns })");
    expect(src).toContain("const exact = exactFailuresSince(goalFailureMemory.get(hash) ?? [], since(hash));");
    expect(src).toMatch(/shape: "goalDeficiencyPolicy"[\s\S]{0,200}min_runs/);
  });
});
