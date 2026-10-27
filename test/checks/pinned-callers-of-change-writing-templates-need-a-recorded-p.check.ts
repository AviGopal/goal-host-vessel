import { describe, it, expect } from "bun:test";
import * as WriteDoorModule from "../../src/write-door";

describe("Pinned callers of change-writing templates", () => {
  it("fails when caller declares a change shape, but product is not a change", () => {
    const ctx = {
      admittedEditRoute: false,
      declaredOutputShapes: ["activity_create_variant"], // A change shape
    };

    // The recorded policy (user ruling 2026-10-27, "Store product (Recommended)"; the shaped writeDoorPolicy, whose
    // default it is): activity_create_variant is the goal's own declared product, so declaring it does NOT admit the
    // dispatch as a code/file change, and its write is admitted as that product.
    expect(WriteDoorModule.admittedChange(ctx)).toBe(false);
    const { writeDoor } = WriteDoorModule.taskWriteDoor(false, ctx.declaredOutputShapes);
    expect(writeDoor.governs("activity_create_variant")).toBe(false);
    expect(writeDoor.governs("fs_edit")).toBe(true);
    // Control: a dispatch declaring nothing still has the same write refused.
    const undeclared = WriteDoorModule.admittedChange({ admittedEditRoute: false, declaredOutputShapes: undefined });
    expect(undeclared).toBe(false);
    expect(WriteDoorModule.taskWriteDoor(undeclared, []).writeDoor.governs("activity_create_variant")).toBe(true);
  });
});
