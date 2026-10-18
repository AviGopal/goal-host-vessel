import { describe, it, expect } from "bun:test";
import * as WriteDoorModule from "../../src/write-door";

describe("Pinned callers of change-writing templates", () => {
  it("fails when caller declares a change shape, but product is not a change", () => {
    const ctx = {
      admittedEditRoute: false,
      declaredOutputShapes: ["activity_create_variant"], // A change shape
    };

    // The defect: activity_create_variant is a CHANGE_PRIMITIVE_SHAPE (line 73 of write-door.ts).
    // callerDeclaresWrite (line 104) will return true for it.
    // admittedChange (line 108) then returns true because callerDeclaresWrite is true.
    // This means declaring a change shape admits the WHOLE dispatch as a change.
    // This is a policy decision, not a mechanical fix, and should fail.
    expect(WriteDoorModule.admittedChange(ctx)).toBe(false);
  });
});
