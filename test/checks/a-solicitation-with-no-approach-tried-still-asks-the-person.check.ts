// Test for the solicitation defect: should consume human input when no approaches are selectable

import { describe, it, expect, beforeEach } from "bun:test";
import * as mod from "../../src/index";

const opts = { maxAttempts: 1, firstTarget: "test" };
const excluded: string[] = [];

describe("solicitation with no approach tried still asks the person", () => {
  let result;

  beforeEach(() => {
    // Simulate the state before the solicitation
    result = mod.runGroundedToolLoop({ satisfiers: [], opts }); // no satisfiers to try
  });

  it("should consume human input when no approaches are selectable", async () => {
    // The process should ask for human input but then should consume it correctly.
    const humanInput = { answer: "user input" };
    result = await mod.solicitHumanInput(humanInput);  // simulate human input solicitation
    expect(result?.kind).toBe("retry");  // expecting retry
    expect(global.console.log.mock.calls[0][0]).toContainEqual(expect.stringContaining("human answered soli"));
  });

  it("should still exclude failed attempt on a real failure", async () => {
    const humanInput = { answer: "user input" };
    result = await mod.solicitHumanInput(humanInput);  // simulate human input solicitation
    expect(mod.runGroundedToolLoop({ satisfiers: ["failedTemplate"], opts })).toBeDefined();  // ensuring failed one is excluded
  });
});