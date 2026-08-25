import { describe, it, expect } from "bun:test";
import { goalRequestsDurableArtifact } from "./goal-intent.js";

describe("goalRequestsDurableArtifact", () => {
  it("returns true for a goal with save-style verb and note-or-findings noun", () => {
    const goal = "save findings 'My research notes'";
    expect(goalRequestsDurableArtifact(goal)).toBe(true);
  });

  it("returns false for a goal that has neither a save-style verb nor a note-or-findings noun", () => {
    const goal = "evaluate this prompt";
    expect(goalRequestsDurableArtifact(goal)).toBe(false);
  });
});