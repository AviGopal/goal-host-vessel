// C6 RESTORED: the in-flight recovery pick sends the walk's available shape pool (impulse_shapes) and the goal's direction
// (completion_shapes) to /recommend, so activity-api reads the signature-conditioned posterior instead of selecting
// state-blind. Removed with no gap by the autonomous af61dee (06-28); the original was 4912bb0 (06-26).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { c6StateShapeFields } from "../src/recommend-state-shapes";

const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("C6: the recovery pick is state-conditioned", () => {
  it("[MUST-FAIL] a recovery pick with a pool and a direction sends both impulse_shapes and completion_shapes", () => {
    expect(c6StateShapeFields({ impulse: ["substrateGap", "fs_read"], completion: ["gapDecomposition"] })).toEqual({ impulse_shapes: ["substrateGap", "fs_read"], completion_shapes: ["gapDecomposition"] });
  });

  it("[CONTROL] an empty pool sends no impulse_shapes (the state-blind body, as C6 specified); none at all sends nothing", () => {
    expect(c6StateShapeFields({ impulse: [], completion: ["x"] })).toEqual({ completion_shapes: ["x"] });
    expect(c6StateShapeFields(undefined)).toEqual({});
    expect(c6StateShapeFields({ impulse: [], completion: null })).toEqual({});
  });

  it("[WIRING] /recommend's body spreads the fields; the in-flight retry passes the pool accumulated from each attempt's produced shapes", () => {
    const fn = SRC.slice(SRC.indexOf("async function recommendExcluding"), SRC.indexOf("async function recommendExcluding") + 2500);
    expect(fn).toContain("...c6StateShapeFields(stateShapes)");
    expect(SRC).toContain("for (const s of producedShapes) c6SeekPool.add(s);");
    expect(SRC).toContain("recommendExcluding(goal, [...excluded, ...doorRefusedHeads], repairKey, seededOutputShapes ?? null, undefined, { impulse: [...c6SeekPool], completion: completionShapes ?? seededOutputShapes ?? null }, { admitted: _changeAdmitted, goalHash: goalHashOf(goal), record: tap })");
    expect(SRC).toContain("recommendExcluding(goal, doorRefusedHeads, null, seededOutputShapes, lookupOutcome, { completion: seededOutputShapes }, { admitted: _changeAdmitted, goalHash: goalHashOf(goal), record: tap })");
    expect(SRC).toContain("recommendExcluding(goal, doorRefusedHeads, null, alt, lookupOutcome, { completion: alt }, { admitted: _changeAdmitted, goalHash: goalHashOf(goal), record: tap })");
    expect(SRC).not.toContain("recommendExcluding(goal, [], null,");
  });
});
