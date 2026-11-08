// A CHANGE GOAL IS WALKED (src/edit-intent-route.ts); THERE IS NO COMPOSE HAND-OFF AND NO SWITCH.
//
// When the edit-intent routing rules name a file to change, the dispatch is admitted as a change and walks toward the
// landing shape (cutoverApplied), unconditionally: no mask or env switch is read, and index.ts POSTs no feature_compose.
// A walk step whose output already landed in process (patch_with_tools: landed:true / new_git_sha) satisfies that
// target, so no second landing step is sought.
//
// Seam: index.ts boots the vessel on import, so the dispatch cannot be driven end to end here. The decisions are tested
// on the smallest exported functions that make them (the routing core's handoffRoute, withLandingTarget,
// landingSatisfiedBy, the write-door predicates), and their wiring in index.ts is pinned as text by anchor.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFsWriteShape } from "../src/fs-write-shapes";
import { refusedWrite } from "../src/write-door";

const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
const at = (s: string, from = 0): number => INDEX.indexOf(s, from);

describe("[MUST-FAIL] no compose hand-off: the goal is admitted as a change and targets cutoverApplied", () => {
  test("[MUST-FAIL] index.ts POSTs no feature_compose and reads no route switch", () => {
    expect(INDEX.split('type: "feature_compose"').length - 1).toBe(0);
    expect(INDEX).not.toContain("process.env.ROUTE_EDIT_INTENT_TO_COMPOSE");
    expect(INDEX).not.toContain('process.env["ROUTE_EDIT_INTENT_TO_COMPOSE"]');
    for (const gone of ["editIntentRouteDecision", "editIntentRouteLine", "_editIntentRoute", "earlyHandoff", "earlyEditIntentEnabled", "EARLY EDIT-INTENT"]) {
      expect({ gone, present: INDEX.includes(gone) }).toEqual({ gone, present: false });
    }
  });
  test("wiring: a landed walk counts as an edit (its landing shapes are edit results), so it is not recovered again", () => {
    const shapes = at("const EDIT_RESULT_SHAPES = [");
    expect(shapes).toBeGreaterThan(0);
    const line = INDEX.slice(shapes, INDEX.indexOf("\n", shapes));
    expect(line).toContain('"cutoverapplied"');
    expect(line).toContain('"vesselmitosiscutoverresult"');
  });
});

describe("[CONTROL] filesystem writes stay refused at vesselResolve", () => {
  test("fs_write is a filesystem-write shape, refused on a goal not admitted", () => {
    expect(isFsWriteShape("fs_write")).toBe(true);
    expect(refusedWrite("fs_write")).toBe(true);
  });
  test("vesselResolve refuses it unconditionally (admitted or not), before the admission door", () => {
    const fs = at("if (isFsWriteShape(shape)) { // = write-door.ts isWriteShape: unconditional, admitted or not");
    const door = at("if (!changeAdmitted && refusedWrite(shape, writeDoorProduct)) {", fs);
    expect(fs).toBeGreaterThan(0);
    expect(door).toBeGreaterThan(fs);
    expect(INDEX.slice(fs, door)).toContain("return attemptStructural();");
    expect(INDEX).toContain('const attemptStructural = (): null => { if (curAttempt) curAttempt.structural = true; return null; };');
  });
});
