import { describe, it, expect } from "bun:test";
import * as mod from "../../src/goal-target-inference";

describe("a goal naming a concept id has no deterministic route to the concept read", () => {
  it("must-fail reproduction: concept_* id should deterministically route to a concept read shape", async () => {
    // Probe text carries a concept id token that matches /concept_[A-Za-z0-9_-]{6,}/
    const goal =
      "Turn the drafting-discipline rule in concept_MO2GKBFm-zzA into a check we can enforce";

    // If a deterministic route existed, either 'concept' or 'conceptSearch' would be selected
    // when both are advertised. We also include common read/executor shapes to avoid LLM.
    const knownShapes = ["concept", "conceptSearch", "fileContent", "shellResult"];

    const decision = await mod.inferGoalTargetDecision(goal, knownShapes);

    // Intent (expected, but currently FALSE due to the defect): a concept_* id deterministically
    // binds to a concept read shape.
    expect(
      decision.shapes.some((s) => s === "concept" || s === "conceptSearch")
    ).toBe(true);
  });
});
