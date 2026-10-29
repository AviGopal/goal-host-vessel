import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

describe("observe learning mode is a measurement-era artifact", () => {
  it("MUST-FAIL: observe mode should only add a label to the verdict body, not change other content", () => {
    const executionId = "exec-id-observe-fail";
    const reached = false;
    const completionShapes = ["shape-A"];
    const reason = "some reason text";
    const goalHash = "goal-hash-observe";
    const betaWithheldReason = null;

    const observeResultJson = mod.reachVerdictBody(
      executionId,
      reached,
      completionShapes,
      reason,
      goalHash,
      betaWithheldReason,
      "observe"
    );
    const observeBody = JSON.parse(observeResultJson);

    const normalResultJson = mod.reachVerdictBody(
      executionId,
      reached,
      completionShapes,
      reason,
      goalHash,
      betaWithheldReason,
      undefined // No learningMode
    );
    const normalBody = JSON.parse(normalResultJson);

    // The 'observe' mode should only add the `learning_mode` property.
    // The rest of the body should be identical to a normal call.
    // This assertion is expected to fail because the defect causes other fields to be modified.
    // After the fix, this assertion should pass.
    const { learning_mode, ...observeBodyWithoutLabel } = observeBody;
    expect(learning_mode).toBe("observe");
    expect(observeBodyWithoutLabel).toEqual(normalBody);
  });

  it("CONTROL: reachVerdictBody without learning_mode produces a correct report", () => {
    const executionId = "exec-id-control";
    const reached = true;
    const completionShapes = ["shape-B", "shape-C"];
    const reason = "control test reason";
    const goalHash = "goal-hash-control";
    const betaWithheldReason = "beta withheld";

    const resultJson = mod.reachVerdictBody(
      executionId,
      reached,
      completionShapes,
      reason,
      goalHash,
      betaWithheldReason,
      undefined // No learningMode
    );
    const body = JSON.parse(resultJson);

    expect(body).toEqual({
      execution_id: executionId,
      reached: reached,
      completion_shapes: completionShapes,
      reason: reason.slice(0, 600),
      goal_hash: goalHash,
      beta_withheld_reason: betaWithheldReason,
    });
  });
});
