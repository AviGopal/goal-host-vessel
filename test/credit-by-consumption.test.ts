// SCORED BY CONSUMPTION (USER ruling; finding agf_2wegbdg3j8vo, research's by-effect check of c8120857, dispatch
// 9328a7cb): a walk reached shellResult -> posterior_consistency_audit -> memoryNote_write, where the write consumed
// shellResult and NOTHING consumed the inferred posterior_consistency_audit. That step was still alpha-credited (+2) as
// "involved", because the judge named its shape as a deliverable, and it was baked into the minted composite.
// Now, when a deliverable is a write, involvement starts from the write's producer and follows recorded edges only.
// MUST-FAIL on the parent: involvedSteps seeds every deliverable producer, so the unconsumed step is credited and kept.
// Fixture shapes are invented (5-word draw 2026-10-27T08:18:20Z: rockstar attention reply ride that; tally, drift, journal).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { involvedSteps } from "../src/walk-pool";

type Edge = { inputShapes: string[]; inputImpulseIds: string[]; outputShapes: string[]; outputImpulseIds: string[] };
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
// read -> unconsumed inferred audit -> write that consumed the read
const UNCONSUMED: Edge[] = [
  { inputShapes: [], inputImpulseIds: [], outputShapes: ["tallyRead"], outputImpulseIds: ["r"] },
  { inputShapes: [], inputImpulseIds: [], outputShapes: ["drift_audit"], outputImpulseIds: ["a"] },
  { inputShapes: ["tallyRead"], inputImpulseIds: ["r"], outputShapes: ["journalNote_write"], outputImpulseIds: ["w"] },
];
const ALL = new Set(["tallyRead", "drift_audit", "journalNote_write"]);

describe("involvement follows consumption when the judged artifact is a write", () => {
  test("[MUST-FAIL] an inferred step nothing consumed is not involved (no alpha, not kept in the composite)", () => {
    expect(involvedSteps(UNCONSUMED, ALL)).toEqual([0, 2]);
  });

  test("[MUST-FAIL] the minted composite keeps only the involved steps and says which it dropped", () => {
    expect(SRC).toContain("const _keep = new Set(involvedSteps(_edgesAll, new Set(verdict.completion_shapes ?? []), () => false, stepIsStub));");
    expect(SRC).toContain("dropped_unconsumed_steps: _dropped");
    const keep = SRC.indexOf("const _keep = new Set(involvedSteps(_edgesAll");
    const tag = SRC.indexOf('composite.tags = [...(composite.tags ?? []), compositeGrounded ? "reached:true" : "reached:false"];');
    expect(keep).toBeGreaterThan(0);
    expect(tag).toBeGreaterThan(keep);
  });

  test("[CONTROL] a step the write consumed is credited and kept", () => {
    const consumed: Edge[] = [
      UNCONSUMED[0]!,
      { inputShapes: ["tallyRead"], inputImpulseIds: ["r"], outputShapes: ["drift_audit"], outputImpulseIds: ["a"] },
      { inputShapes: ["drift_audit"], inputImpulseIds: ["a"], outputShapes: ["journalNote_write"], outputImpulseIds: ["w"] },
    ];
    expect(involvedSteps(consumed, ALL)).toEqual([0, 1, 2]);
  });

  test("[CONTROL] with no write among the deliverables every deliverable producer is involved, as before", () => {
    const noWrite = UNCONSUMED.slice(0, 2);
    expect(involvedSteps(noWrite, new Set(["tallyRead", "drift_audit"]))).toEqual([0, 1]);
  });

  test("[CONTROL] mixed deliverables {report, memoryNote_write}: a report producer that did not feed the write is not credited", () => {
    // Scored by consumption: when a deliverable is a write, the write is the judged artifact; a report step beside it that
    // nothing consumed is not involved, even though its shape is also a completion shape.
    const mixed: Edge[] = [
      { inputShapes: [], inputImpulseIds: [], outputShapes: ["tallyRead"], outputImpulseIds: ["r"] },
      { inputShapes: [], inputImpulseIds: [], outputShapes: ["rideReport"], outputImpulseIds: ["p"] },
      { inputShapes: ["tallyRead"], inputImpulseIds: ["r"], outputShapes: ["memoryNote_write"], outputImpulseIds: ["w"] },
    ];
    expect(involvedSteps(mixed, new Set(["rideReport", "memoryNote_write"]))).toEqual([0, 2]);
  });

  test("[CONTROL] an unverified write earns nothing but still credits what fed it", () => {
    expect(involvedSteps(UNCONSUMED, ALL, (i) => i === 2)).toEqual([0]);
  });

  test("[CONTROL] the credit site still reads involvedSteps unchanged", () => {
    expect(SRC).toContain("involvedSteps(_edges, new Set(verdict.completion_shapes ?? []), _uncreditable, _isStub)");
  });
});
