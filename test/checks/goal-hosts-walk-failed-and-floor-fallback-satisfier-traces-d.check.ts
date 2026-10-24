import { describe, expect, test } from "bun:test";
import * as mod from "../../src/index";

describe("goal-hosts-walk-failed-and-floor-fallback-satisfier-traces", () => {
  test("walk-failed and floor-fallback traces include state_signature", () => {
    // Evidence shows unsigned rows are 1,194 (goal-host-walk-failed 965, universal-tool-fallback 210, verdict-corpus-runner 18)
    // while all 922 signed rows are goal-host successes (REALIGNMENT §2.2)
    const walkLog = [{ok: false, tool: "goal-host-walk-failed"}];
    const finalReason = "tool failed";
    const shapes = ["target_shape"];
    const result = mod.rememberDispatchFailures("goalText", walkLog, finalReason, null, shapes, 1);
    expect(result).toContain("state_signature");
  });
});
