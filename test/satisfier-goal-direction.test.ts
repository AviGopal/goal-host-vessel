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

describe("the proven-bad verdict is read per goal direction, with no global fallback, and inert", () => {
  test("[MUST-FAIL] the reader asks for the goal-direction partition and refuses any other answer", () => {
    expect(SRC).toContain("...(direction ? { goal_target_shapes: direction } : {})");
    expect(SRC).toContain('if (direction && (typeof bucket !== "string" || body["signature_version"] !== GOAL_DIRECTION_SIGNATURE_VERSION)) return null;');
    expect(SRC).toContain("const GOAL_DIRECTION_SIGNATURE_VERSION = 3;");
  });
  test("[MUST-FAIL] the walk reads it for EVERY missing shape with the walk's target set", () => {
    const start = SRC.indexOf("// (c1) THE GOAL-DIRECTION READER, INERT");
    const block = SRC.slice(start, SRC.indexOf("const _provenBadSingle", start));
    expect(start).toBeGreaterThan(0);
    expect(block).toContain("missingForSatisfier.map(async (s) => ({ shape: String(s), rel: await fetchSatisfierReliability(String(s), _dirTargets) }))");
    expect(block).toContain("satisfierProvenBad(_rel.alpha, _rel.beta, _rel.samples)");
    expect(block).not.toContain("_provenBadShapes.add(");
  });
  test("[MUST-FAIL] the env interlock is gone (law 1)", () => {
    expect(SRC).not.toMatch(/process\.env\[\s*["']SATISFIER_PROVEN_BAD_ARMED["']\s*\]/);
    expect(SRC).not.toContain("SATISFIER_SUPPRESSION_ARMED");
    const list = JSON.parse(readFileSync(join(import.meta.dir, "ratchet", "env-read-ratchet.list.json"), "utf8")) as Array<{ name: string }>;
    expect(list.some((e) => e.name === "SATISFIER_PROVEN_BAD_ARMED")).toBe(false);
  });
});
