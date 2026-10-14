// RECURRING DEMAND (openspec contained-self-development 8.14's "revisit only for shapes with recurring demand"; 2026-10-13): the
// SAME goal failing at least R2's min_runs times since its last reach is demand; a one-off goal stays born closed.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityDemand, exactFailuresSince } from "../src/capability-demand";

const G = "tabulate the quarry ledger per depot";
describe("capabilityDemand", () => {
  it("MUST-FAIL: a one-off goal (fewer failures than min_runs) is still born closed, and the same goal again writes nothing", () => {
    expect(capabilityDemand({ priorGoals: [], goalKey: G, priorFailures: 0, minRuns: 3 })).toEqual({ skip: false, demandGoals: [G], demanded: false, recurring: false });
    expect(capabilityDemand({ priorGoals: [G], goalKey: G, priorFailures: 2, minRuns: 3 })).toMatchObject({ skip: true, demanded: false });
  });
  it("MUST-FAIL: the same goal recurring >= min_runs times is demand: filed OPEN (a closed row reopens), without duplicating the goal", () => {
    expect(capabilityDemand({ priorGoals: [G], goalKey: G, priorFailures: 3, minRuns: 3 })).toEqual({ skip: false, demandGoals: [G], demanded: true, recurring: true });
    expect(capabilityDemand({ priorGoals: [], goalKey: G, priorFailures: 5, minRuns: 3 })).toEqual({ skip: false, demandGoals: [G], demanded: true, recurring: true });
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
  it("structural: fileCapabilityGap and recallGoalFailures use these rules, and min_runs comes from goalDeficiencyPolicy", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(src).toContain("const priorFailures = recallGoalFailures(goal).exact.length;");
    expect(src).toContain("capabilityDemand({ priorGoals, goalKey, priorFailures, minRuns })");
    expect(src).toContain("const exact = exactFailuresSince(goalFailureMemory.get(hash) ?? [], since(hash));");
    expect(src).toMatch(/shape: "goalDeficiencyPolicy"[\s\S]{0,200}min_runs/);
  });
});
