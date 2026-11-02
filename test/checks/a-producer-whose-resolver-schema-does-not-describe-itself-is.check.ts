import { describe, it, expect } from "bun:test";
import { bindRequiredInputs } from "../../src/resolve-pointer.js";

describe("A producer whose resolver_schema does not describe itself", () => {
  it("should return unbindable required input error when contract is known:false", () => {
    const result = bindRequiredInputs({
      shape: "resolver_schema",
      pointer: {},
      contract: { known: false, fields: [] },
      goal: "",
      upstream: [],
    });
    expect(result.invoke).toBe(false);
    if (!result.invoke) {
      expect(result.reason).toMatch(/unbindable required input/);
    }
  });

  it("control test: should invoke producer with known:true contract and bound inputs unchanged", () => {
    const result = bindRequiredInputs({
      shape: "some_shape",
      pointer: { requiredInput: "value" },
      contract: { known: true, fields: [{ name: "requiredInput", required: true }] },
      goal: "",
      upstream: [],
    });
    expect(result.invoke).toBe(true);
    if (result.invoke) {
      expect(result.pointer).toEqual({ requiredInput: "value" });
    }
  });
});
