import { describe, it, expect } from "bun:test";
import * as mod from "../../src/floor-tools";

describe("Floor toolset for grounding", () => {
  // This is the MUST-FAIL check that reproduces the defect.
  // The goal states that the 'floor' (universalToolFallback) is constrained to UNIVERSAL_READ_TOOLS,
  // which lacks web search capabilities. This makes it impossible to ground goals that need current
  // or external information. This test asserts that the toolset used for grounding should contain
  // 'web_search'. It fails because UNIVERSAL_READ_TOOLS does not, directly reproducing the gap.
  it("fails because the grounding toolset (UNIVERSAL_READ_TOOLS) lacks web_search", () => {
    const groundingToolNames = mod.UNIVERSAL_READ_TOOLS.map((t) => t.name);
    const toolSet = new Set(groundingToolNames);

    // This assertion will fail, because 'web_search' is not in the set.
    expect(toolSet.has("web_search")).toBe(true);
  });

  // This is the CONTROL check, which must pass now and after the fix.
  // It confirms that 'web_search' is correctly included in the more comprehensive UNIVERSAL_FLOOR_TOOLS
  // constant. This highlights that the defect is about which toolset is selected for grounding,
  // not about the tool's definition being missing entirely.
  it("passes because the complete floor toolset (UNIVERSAL_FLOOR_TOOLS) includes web_search", () => {
    const completeToolNames = mod.UNIVERSAL_FLOOR_TOOLS.map((t) => t.name);
    const toolSet = new Set(completeToolNames);

    // This assertion will pass now and should continue to pass.
    expect(toolSet.has("web_search")).toBe(true);
  });
});
