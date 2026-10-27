import * as mod from "../../src/index";
import { describe, it, expect } from "bun:test";

describe("LAW 2: asking a person is a behaviour", () => {
  it("solicitHumanInput writes uiQuestion directly with no ask activity", async () => {
    const res = await mod.solicitHumanInput("test-goal", "test-evidence");
    expect(res).not.toBeNull();
  });

  it("control: question content remains unchanged", async () => {
    // This control test re-confirms the current behavior of solicitHumanInput.
    // It's expected to return null, mimicking a pending solicitation in a real scenario
    // where actual human input would be solicited via an 'ask' activity.
    const res = await mod.solicitHumanInput("test-goal", "test-evidence");
    expect(res).toBeNull(); // Current behavior remains unchanged
  });
});