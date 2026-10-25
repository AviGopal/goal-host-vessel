import { describe, it, expect } from "bun:test";
import * as WriteDoorModule from "../../src/write-door";

describe("Pinned callers of change-writing templates", () => {
  it("the recorded policy: a caller that declares activity_create_variant is admitted as a change", () => {
    const ctx = {
      admittedEditRoute: false,
      declaredOutputShapes: ["activity_create_variant"], // A change shape
    };

    // User ruling 2026-10-25: activity_create_variant is a change shape, and declaring it in expected_output_shapes
    // admits the dispatch like any other declared change shape (callerDeclaresWrite in write-door.ts).
    expect(WriteDoorModule.admittedChange(ctx)).toBe(true);
    // Control: a dispatch declaring nothing still has the same write refused.
    const undeclared = WriteDoorModule.admittedChange({ admittedEditRoute: false, declaredOutputShapes: undefined });
    expect(undeclared).toBe(false);
    expect(WriteDoorModule.taskWriteDoor(undeclared, []).writeDoor.governs("activity_create_variant")).toBe(true);
  });
});
