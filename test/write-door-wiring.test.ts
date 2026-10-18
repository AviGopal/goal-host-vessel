// THE WRITE DOORS — WIRING (source pins on index.ts; the walk is a closure that cannot run without the fleet).
// Measured: a read-only goal inferred ["fs_edit"] ran auto-bridge-fs_edit at an ordinary template pick and again at
// the composite path. Every door that can choose a write producer or target calls the shared write-door.ts helper,
// and admission is set only where the edit-intent route hands the dispatch to feature_compose.
import { describe, expect, test } from "bun:test";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const after = (anchor: string, span: number): string => {
  const i = src.indexOf(anchor);
  expect(i).toBeGreaterThan(0);
  return src.slice(i, i + span);
};

describe("write doors are wired", () => {
  test("template pick: the walk's candidates pass the door before any single-pick tier", () => {
    const door = src.indexOf('candidates = writeDoorFilter(candidates, (c) => c.outputShapes, changeAdmitted, "template_pick"');
    expect(door).toBeGreaterThan(0);
    expect(door).toBeLessThan(src.indexOf("// (b) SELECT BEST — goal-gap weighted."));
  });
  test("template pick: the horizontal OR-edge's own forward fetch passes the door", () => {
    expect(src).toContain('forward = writeDoorFilter(forward, (c) => c.outputShapes, changeAdmitted, "template_pick"');
  });
  test("composite pick: missing targets and the composite's outputs both pass the door", () => {
    expect(src).toContain('const _missingC = writeDoorShapes([...target].filter((s) => !producedShapes.has(s)), changeAdmitted, "composite_pick"');
    expect(after("const _c = await authorComposite(", 400)).toContain('writeDoorFilter([_c.pick], (p) => p.outputShapes, changeAdmitted, "composite_pick"');
  });
  test("bridge pick: no wrapper is minted around a write resolver", () => {
    expect(src).toContain('const missingTargets = writeDoorShapes([...target].filter((s) => !producedShapes.has(s)), changeAdmitted, "bridge_pick"');
  });
  test("recovery pick: recommendExcluding refuses write producers and every call site passes the admission", () => {
    expect(src).toContain('writeDoorFilter([x], () => recShapes.map(String), writeDoor.admitted, "recovery_pick"');
    expect(src.match(/recommendExcluding\(goal, [^\n]*\{ admitted: _changeAdmitted, goalHash: goalHashOf\(goal\), record: tap \}\)/g)?.length).toBe(3);
  });
  test("target: the walk's target and the dispatch's seeded target pass the door", () => {
    expect(src).toContain('const target = new Set<string>(writeDoorShapes(opts.expectedOutputShapes ?? [], changeAdmitted, "target"');
    const seed = src.indexOf('if (seededOutputShapes) seededOutputShapes = writeDoorShapes(seededOutputShapes, false, "target"');
    expect(seed).toBeGreaterThan(0);
    expect(seed).toBeLessThan(src.indexOf("reachingPathway = await recommendReachingPath(goal, seededOutputShapes ?? null);", seed));
  });
  test("satisfier and vesselResolve stay unconditional and count their refusals", () => {
    expect(src).toContain('noteWriteRefusal("satisfier", _fsBlocked.length);');
    expect(after("const vesselResolveShapeInner = async (shape: string)", 1200)).toContain('noteWriteRefusal("vessel_resolve");');
  });
  test("admission: set only where the edit-intent route hands off to feature_compose, carried to every walk", () => {
    expect(after('if (earlyHandoff.route === "feature_compose" && earlyHandoff.target) {', 120)).toContain("_changeAdmitted = true;");
    expect(src.match(/_changeAdmitted = true/g)?.length).toBe(1);
    expect(src).toContain("let _changeAdmitted = admittedChange({ admittedEditRoute: false, declaredOutputShapes: opts.expectedOutputShapes });");
    expect(src.match(/runGoalAsPoolWalk\(goal, \{\n\s*changeAdmitted: _changeAdmitted,/g)?.length).toBe(4);
    expect(src).toContain("const changeAdmitted = opts.changeAdmitted === true;");
  });
  test("the counters are published on /health", () => {
    expect(src).toContain("write_door: writeDoorCounters(),");
  });
});
