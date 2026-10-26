import { describe, test, expect } from "bun:test";
import * as mod from "../../src/index";

describe("route-edit artifact degradation (gap route-edit-49136a8a)", () => {
  test("a count derived from a string should use the correct metric", () => {
    // The observation describes an artifact being updated with an incorrect value
    // based on a miscalculation: `lettercount(resilient)` yielding 10 (length)
    // instead of 9 (unique letters). This test reproduces that class of error
    // using an exported function that takes a string input.
    const digestBase = "resilient";
    const result = mod.floorGroundingDigest(1, 1, digestBase);

    // The digest is expected to be based on a metric that evaluates to 9 for "resilient".
    // The defect causes it to be based on string length (10), making this assertion fail.
    expect(result).toBe("gr-1/1/base-9");
  });
});
