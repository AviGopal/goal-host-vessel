import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

describe("Capability routing producer matching", () => {
  // Law 3: The walk must reuse existing producers/routes that serve a goal's needs.
  // This test reproduces a defect where the capability route check compares shape NAMES exactly,
  // violating Law 3. A free-form goal's walk-inferred output name (which no repo declares)
  // is dispatched as a new producer request, even when an existing producer already serves the need
  // under a different, but semantically equivalent, shape name.
  // We test the downstream effect on dispatch failure reporting.

  it("FAIL: reuses a producer with a semantically equivalent shape name instead of reporting a capability gap", () => {
    // This walkLog simulates the current, defective behavior. The 'RouteCapability' step failed
    // to find a producer for 'walk-inferred-output-name' because it only checked for an exact name match.
    const walkLog = [
      {
        step: "RouteCapability",
        reason: "producer-not-found-by-exact-name",
        shape: "walk-inferred-output-name",
      },
    ];
    // The final reason from the walk would indicate a failure to find a producer.
    const finalReason = "Walk failed to find a capable producer.";

    const reasons = mod.dispatchFailureReasons(walkLog as unknown as ReadonlyArray<Record<string, unknown>>, finalReason);

    // After the fix, the router would find an existing, equivalent producer.
    // Thus, this 'producer-not-found' log would not be generated, and `dispatchFailureReasons`
    // would not create a message about a missing producer. This assertion fails now, reproducing the defect.
    expect(reasons.join(" ")).not.toMatch(/producer for shape walk-inferred-output-name/i);
  });

  it("CONTROL: reports a capability gap when no equivalent producer exists", () => {
    // This walkLog simulates a legitimate failure: no producer exists for this shape,
    // either by exact name or by any other equivalence. This reporting behavior must be preserved.
    const walkLog = [
      {
        step: "RouteCapability",
        reason: "producer-not-found",
        shape: "a-truly-unsupported-capability",
      },
    ];
    const finalReason = "Walk failed to find a capable producer.";

    const reasons = mod.dispatchFailureReasons(walkLog as unknown as ReadonlyArray<Record<string, unknown>>, finalReason);

    // It is correct to report a missing producer in this case. This test should always pass.
    expect(reasons.join(" ")).toMatch(/producer for shape a-truly-unsupported-capability/i);
  });
});
