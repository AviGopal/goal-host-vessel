// (c1) THE GOAL-DIRECTION KEY (user ruling 2026-10-17T08:34:28Z, "Build the key now, read post-run").
// goal-host's two satisfier trace builders carry the walk's target shape set (metadata.goal_target_shapes) so
// activity-api keys a satisfier's outcome by goal direction, in its own partition (signature_version 3), not only by the
// one constant pool bucket every satisfier had (sha256("1|X||")[:16]). The proven-bad verdict is read from that partition
// with no global fallback, and the SATISFIER_PROVEN_BAD_ARMED env interlock is deleted (law 1; env-read ratchet updated).
// The walk is a closure that cannot run without the fleet, so these are source pins; activity-api's derivation and the
// live round trip are tested where they run.
// MUST-FAIL on the parent (d124f2f): no goal_target_shapes, the reader reads the global row, the env read is present.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

describe("satisfier traces carry the goal direction", () => {
  test("[MUST-FAIL] both satisfier trace builders send the walk's target set", () => {
    expect(SRC).toContain("metadata: { satisfier: true, shape: satisfiableNow, ...(target.size > 0 ? { goal_target_shapes: [...target].sort() } : {}) },");
    expect(SRC).toContain("metadata: { satisfier: true, shape: missingShape, ...(target.size > 0 ? { goal_target_shapes: [...target].sort() } : {}) },");
    // and no satisfier builder is left sending only the old metadata
    expect(SRC).not.toMatch(/metadata: \{ satisfier: true, shape: [A-Za-z]+ \},/);
  });
});
