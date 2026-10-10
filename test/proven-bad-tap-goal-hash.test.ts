// THE "would be PROVEN-BAD … suppression is HELD" TAP NAMES ITS GOAL (OP-1 e).
//
// diag-1d counted 390 of these lines in 24h across 33 shapes, but could not join them to a goal: the HOLLOW and
// reached lines carry goal_hash=<hash>, this one did not. Before the suppression can be armed (after a measured
// clean window), each held verdict must be attributable to the goals it would have changed. Instrumentation
// only: the line gains goal_hash, in the same form as its siblings; no behaviour changes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

describe("MUST-FAIL — the PROVEN-BAD hold tap carries goal_hash", () => {
  const line = SRC.split("\n").find((l) => l.includes("would be PROVEN-BAD") && l.includes("suppression is HELD")) ?? "";
  test("the tap is found", () => { expect(line).toContain("tap(`"); });
  test("it carries goal_hash=${goalHashOf(goal)}, the form the HOLLOW line uses", () => {
    expect(line).toContain("goal_hash=${goalHashOf(goal)}");
    const hollow = SRC.split("\n").find((l) => l.includes("walk(${opts.surface}): HOLLOW — ${verdict.reason};")) ?? "";
    expect(hollow).toContain("goal_hash=${goalHashOf(goal)}");
  });
  test("the hold is still a hold: the tap stays gated on the unarmed interlock", () => {
    const i = SRC.indexOf(line);
    expect(SRC.slice(Math.max(0, i - 300), i)).toContain("if (_rel && !SATISFIER_SUPPRESSION_ARMED && satisfierProvenBad(_rel.alpha, _rel.beta, _rel.samples)) {");
  });
});
