/**
 * The floor (universalToolFallback) is told the real date for a time-relative goal, under the same condition as the
 * walk's own prompts (timeRelativeOffset(goal) !== null), so "yesterday"/"today" resolve to the substrate's clock.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { temporalGroundingBlock, timeRelativeOffset } from "../src/reach-date";

const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

describe("floor temporal grounding", () => {
  test("[WIRING MF] the floor prompt carries the date block under the walk's condition", () => {
    expect(src).toContain("const prompt = `${timeRelativeOffset(goal) !== null ? temporalGroundingBlock() : \"\"}You are the substrate's universal executor.");
  });
  test("[CONTROL] the condition is the walk's: a time-relative goal gets the block, a timeless one does not", () => {
    expect(timeRelativeOffset("what happened yesterday in the repo")).not.toBeNull();
    expect(timeRelativeOffset("count the files in the repo")).toBeNull();
    expect(temporalGroundingBlock().length).toBeGreaterThan(0);
  });
});
