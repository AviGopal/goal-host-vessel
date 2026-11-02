import { describe, it, expect, beforeEach } from "bun:test";
import * as mod from "../../src/index";

const { deliverReachVerdict, __reachedCommandCacheForTests: cache } = mod;

describe("learning_mode: 'observe' side effects", () => {
  it("should not treat an edit goal as 'reached' when learning_mode is 'observe'", async () => {
    const goalHash = "goal-hash-observe-mode";
    const executionId = "exec-id-observe-mode";

    await deliverReachVerdict(
      executionId,
      true, // The system currently marks it as reached, which is the bug
      ["feature_compose:landed_edit"], // A plausible shape for a landed edit
      "test-origin",
      "An edit was landed",
      goalHash,
      undefined,
      "observe" // This is an observation run
    );

    // The defect is that 'observe' mode doesn't prevent the side-effect of
    // caching the reach verdict. The fix should prevent this. We assert the
    // desired behavior, which will fail with the current code.
    expect((cache as any)[goalHash]).toBeUndefined();
  });

  it("should mark a goal as reached in the cache for a normal run (control)", async () => {
    const goalHash = "goal-hash-normal-run";
    const executionId = "exec-id-normal-run";

    await deliverReachVerdict(
      executionId,
      true,
      ["feature_compose:landed_edit"],
      "test-origin",
      "An edit was landed",
      goalHash,
      undefined,
      undefined // No learning_mode
    );

    // This is the normal behavior and should continue to work. The cache should be updated.
    const cachedVerdict = (cache as any)[goalHash];
    expect(cachedVerdict).toBeDefined();
    if (cachedVerdict) {
      expect((cachedVerdict as { reached: boolean }).reached).toBe(true);
    }
  });
});
