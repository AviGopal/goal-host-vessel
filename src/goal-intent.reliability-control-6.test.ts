import { isEditIntentGoal } from './goal-intent';
import { describe, it, expect } from "bun:test";

describe("isEditIntentGoal tests", () => {
  it("returns false for 'what is the current status'", () => {
    expect(isEditIntentGoal('what is the current status')).toBe(false);
  });

  it("returns false for 'summarize the logs'", () => {
    expect(isEditIntentGoal('summarize the logs')).toBe(false);
  });
});
