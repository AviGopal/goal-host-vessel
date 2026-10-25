// This test checks if the write door correctly refuses write shapes when the goal is not admitted as a change.

import * as mod from "../../src/write-door";
import { describe, it, expect } from "bun:test";

describe("write-door shape refusal", () => {
  it("should refuse a write shape when not admitted as a change", () => {
    const shape = "nonChangeShape"; // the shape that should be refused
    const goalProduct = new Set<string>([]); // empty set simulating no products from the goal

    const result = mod.refusedWrite(shape, goalProduct);
    expect(result).toBe(true); // assertion expects the refusal to be true
  });
});
