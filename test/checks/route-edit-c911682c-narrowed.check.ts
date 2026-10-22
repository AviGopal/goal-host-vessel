import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

describe("route-edit-c911682c-narrowed: deterministic compute must execute procedure, not generate", () => {
  it("rejects a generated wrong lettercount when shellResult provides the correct value", () => {
    // Evidence: we provide both a structured shellResult (truth: 16) and a conflicting generated final text (wrong: 17).
    const goal = 'Compute the lettercount of "incontrovertible" using an exact procedure; emit only the count.';
    const dig = [
      "- tool: shellResult",
      "- stdout: 16",
      '{"tool":"shellResult","stdout":"16","ok":true}',
      "finalText: lettercount 17 for incontrovertible",
    ].join("\n");

    const verdict = mod.verifyDeterministicCompute(goal, dig);

    // Intent: the verifier must prefer the executed tool's exact result over a generated claim and mark the answer as not reached.
    expect(verdict).not.toBeNull();
    expect((verdict as { reached: boolean }).reached).toBe(false);
  });
});
