import { it, expect } from "bun:test";
import * as mod from "../../src/write-door.js";

it('MUST-FAIL: writeDropLine tags undeclared_output and goal_hash for non-admitted goal (expected "[write-door] undeclared_output: goal not admitted as a change (door=recovery_pick, goal_hash=ee232b2)")', () => {
  const line = mod.writeDropLine("recovery_pick", ["producer-with-no-declared-outputs"], "ee232b2");
  // Correct behaviour: the line records the undeclared-output admission, with door and goal_hash
  expect(line).toContain("undeclared_output");
  expect(line).toContain("door=recovery_pick");
  expect(line).toContain("goal_hash=ee232b2");
});

it("CONTROL: git_commit is recognised as a write shape", () => {
  expect(mod.isWriteShape("git_commit")).toBe(true);
});
