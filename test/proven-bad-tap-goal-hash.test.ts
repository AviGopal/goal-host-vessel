// THE "would be PROVEN-BAD" TAP NAMES ITS GOAL (OP-1 e).
//
// diag-1d counted 390 of these lines in 24h across 33 shapes, but could not join them to a goal: the HOLLOW and
// reached lines carry goal_hash=<hash>, this one did not. Each recorded verdict must be attributable to the goals it
// would have changed. Instrumentation only: the line carries goal_hash, in the same form as its siblings.
// (c1), 2026-10-17: the verdict is now read per GOAL DIRECTION and the env interlock is deleted; the reader is INERT
// (recorded, not acted on) until the post-run reading, so "the hold is still a hold" is pinned on the reader itself.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

describe("MUST-FAIL — the PROVEN-BAD verdict tap carries goal_hash", () => {
  const line = SRC.split("\n").find((l) => l.includes("would be PROVEN-BAD") && l.includes("reader INERT")) ?? "";
  test("the tap is found", () => { expect(line).toContain("tap(`"); });
  test("it carries goal_hash=${goalHashOf(goal)}, the form the HOLLOW line uses", () => {
    expect(line).toContain("goal_hash=${goalHashOf(goal)}");
    const hollow = SRC.split("\n").find((l) => l.includes("walk(${opts.surface}): HOLLOW — ${verdict.reason};")) ?? "";
    expect(hollow).toContain("goal_hash=${goalHashOf(goal)}");
  });
  test("the reader is still inert: the verdict block records and never adds a shape to _provenBadShapes", () => {
    const start = SRC.indexOf("// (c1) THE GOAL-DIRECTION READER, INERT");
    const end = SRC.indexOf("const _provenBadSingle = _provenBadShapes.size > 0;", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(SRC.slice(start, end)).not.toContain("_provenBadShapes.add(");
  });
});
