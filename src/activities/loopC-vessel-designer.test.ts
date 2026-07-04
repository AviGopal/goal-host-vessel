/**
 * Tests for Loop-C Vessel Designer activity
 */

import { describe, it, expect } from "bun:test";
import type { VesselScenario, VesselDesign } from "./loopC-vessel-designer";

describe("loopC-vessel-designer types", () => {
  it("VesselScenario requires capability_shape and demanding_template_count", () => {
    const scenario: VesselScenario = {
      capability_shape: "text-summarisation",
      demanding_template_count: 5,
      description: "Summarise long documents",
    };
    expect(scenario.capability_shape).toBe("text-summarisation");
    expect(scenario.demanding_template_count).toBe(5);
  });

  it("VesselDesign includes required tags", () => {
    const design: VesselDesign = {
      vessel_name: "text-summariser-vessel",
      capability_shape: "text-summarisation",
      demanding_template_count: 5,
      impulse_types: ["text.summarise"],
      description: "Summarises long documents",
      rationale: "Expands ΔS by adding summarisation capability",
      tags: ["boredom_target_template", "lift.autonomous.loop", "vessel.addition"],
    };
    expect(design.tags).toContain("boredom_target_template");
    expect(design.tags).toContain("lift.autonomous.loop");
    expect(design.tags).toContain("vessel.addition");
  });
});
