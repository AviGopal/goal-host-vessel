import { describe, it, expect } from "bun:test";
import { goalRequestsDurableArtifact } from "./goal-intent";

describe("goalRequestsDurableArtifact", () => {
  it("should return true for goals with save-style verb and note-or-findings noun", () => {
    expect(goalRequestsDurableArtifact("save the document notes")).toBe(true);
  });

  it("should return false for goals without save-style verb and note-or-findings noun", () => {
    expect(goalRequestsDurableArtifact("just a reminder")).toBe(false);
  });
});
