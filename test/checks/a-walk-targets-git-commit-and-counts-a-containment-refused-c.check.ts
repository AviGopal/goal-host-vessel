import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

describe("walk targets git_commit and counts a containment-refused commit", () => {
  it('extracts a git_commit satisfier call and marks it ok (a goal WALK must)', () => {
    const j: unknown = [
      'VESSEL-RESOLVE SATISFIER produced "git_commit"',
      'write refused by containment: /vessels/development-vessel is in the vessel runtime /vessels',
      'VESSEL-RESOLVE SATISFIER produced "git_commit"',
      'write refused by containment: /vessels/development-vessel is in the vessel runtime /vessels',
      'VESSEL-RESOLVE SATISFIER produced "git_commit"',
    ];
    const calls = mod.executedToolCallsOf(j);
    // Ensure we have a call object to assert on (avoid a non-assertion failure from property access)
    expect(Array.isArray(calls) && calls.length > 0).toBe(true);
    const first = (calls as unknown[])[0] as Record<string, unknown>;
    expect(first["tool"]).toBe("git_commit");
    // Fails under the defect: containment held and no commit landed, but a goal WALK must.
    expect(first["ok"]).toBe(true);
  });
});
