// THE WRITE DOORS, BEYOND THE FILESYSTEM (write-door.ts): on a goal not admitted as a change, a change shape (drafter,
// landing or mutating primitive) is never targeted, picked or composed, and a store write runs only as the goal's own
// product. Measured: a learned composition on a goal not admitted ran uiPanel_write, concept_write (from a composed
// child) and code_modification_proposal; a read-only goal was inferred ["config_file","apply_proposal_as_patch"].
// Namespace import, so on a module without the new helpers the assertions (not the link) fail.
import { beforeEach, describe, expect, it } from "bun:test";

import * as door from "./write-door";

type C = { id: string; outputShapes: string[] };
const UI_PANEL: C = { id: "learned-composition-uipanel-write-to-resolver-pattern-report", outputShapes: ["uiPanel_write", "resolver_pattern_report"] };
const CONCEPT: C = { id: "composed-cap-examine-the-most-recent-successful-multi", outputShapes: ["recurringPatternCluster", "concept_write"] };
const PROPOSAL: C = { id: "producer-of-code_modification_proposal", outputShapes: ["code_modification_proposal"] };
const READER: C = { id: "resolver-pattern-reader", outputShapes: ["resolver_pattern_report"] };
const DECOMPOSER: C = { id: "gap-decomposer", outputShapes: ["gapDecomposition"] };
const NOTE_WRITER: C = { id: "shell-then-note", outputShapes: ["shellResult", "memoryNote_write"] };

const notAdmitted = door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: undefined });
const filter = (d: door.WriteDoor, cands: C[], admitted: boolean, product: string[], lines: string[]) =>
  (door.writeDoorFilter as (...a: unknown[]) => C[])(cands, (c: C) => c.outputShapes, admitted, d, "8daaf150", (l: string) => lines.push(l), (c: C) => c.id, new Set(product));

describe("write door classes", () => {
  beforeEach(() => door.resetWriteDoorCounters());

  it("must-fail: a not-admitted goal drops uiPanel_write, concept_write and code_modification_proposal producers at template pick", () => {
    const lines: string[] = [];
    const kept = filter("template_pick", [UI_PANEL, CONCEPT, PROPOSAL, READER], notAdmitted, ["resolver_pattern_report"], lines);
    expect(kept.map((c) => c.id)).toEqual([READER.id]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`dropped ${UI_PANEL.id},${CONCEPT.id},${PROPOSAL.id}: goal not admitted as a change (door=template_pick`);
    expect(door.writeDoorCounters().template_pick).toBe(3);
  });

  it("must-fail: the composite door refuses a composite whose outputs carry a store write the goal never asked for", () => {
    const lines: string[] = [];
    expect(filter("composite_pick", [CONCEPT], notAdmitted, [], lines)).toEqual([]);
    expect(filter("composite_pick", [PROPOSAL], notAdmitted, ["code_modification_proposal"], lines)).toEqual([]);
    expect(door.writeDoorCounters().composite_pick).toBe(2);
  });

  it("must-fail: the target door drops apply_proposal_as_patch and patch_with_tools from a read-only goal's inferred targets", () => {
    const lines: string[] = [];
    // The live instance: "Leave the file untouched and tell me what would change in repos/goal-host-vessel/src/edge-blend.ts".
    expect(door.writeDoorShapes(["config_file", "apply_proposal_as_patch"], notAdmitted, "target", "h", (l) => lines.push(l))).toEqual(["config_file"]);
    expect(door.writeDoorShapes(["patch_with_tools", "fileContent"], notAdmitted, "target", "h", (l) => lines.push(l))).toEqual(["fileContent"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("dropped apply_proposal_as_patch");
  });

  it("must-fail: the executor's task door refuses the same shapes on a goal not admitted", () => {
    const twd = (door as unknown as { taskWriteDoor?: (a: boolean, p: Iterable<string>) => { writeDoor: { admitted: boolean; governs: (s: string) => boolean } } }).taskWriteDoor;
    expect(typeof twd).toBe("function");
    const { writeDoor } = twd!(false, ["memoryNote_write"]);
    expect(writeDoor.admitted).toBe(false);
    for (const s of ["uiPanel_write", "concept_write", "code_modification_proposal", "apply_proposal_as_patch", "fs_edit"]) expect(writeDoor.governs(s)).toBe(true);
    for (const s of ["memoryNote_write", "resolver_pattern_report", "llmCompletion", "gapDecomposition", "poolImpulse_write"]) expect(writeDoor.governs(s)).toBe(false);
    expect(twd!(true, []).writeDoor.admitted).toBe(true);
  });

  it("control: an admitted goal keeps every write producer", () => {
    const lines: string[] = [];
    const admitted = door.admittedChange({ admittedEditRoute: true, declaredOutputShapes: null });
    expect(filter("template_pick", [UI_PANEL, CONCEPT, PROPOSAL], admitted, [], lines)).toEqual([UI_PANEL, CONCEPT, PROPOSAL]);
    expect(door.writeDoorShapes(["apply_proposal_as_patch"], admitted, "target", "h")).toEqual(["apply_proposal_as_patch"]);
    expect(lines).toEqual([]);
  });

  it("control: gapDecomposition is kept on a not-admitted gap goal", () => {
    const declared = ["gapDecomposition"];
    const admitted = door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: declared });
    expect(admitted).toBe(false);
    expect(door.writeDoorShapes(declared, admitted, "target", "h")).toEqual(declared);
    expect(filter("template_pick", [DECOMPOSER], admitted, declared, [])).toEqual([DECOMPOSER]);
  });

  it("control: a store write that IS the goal's product stays, and declaring one admits no change", () => {
    const product = ["shellResult", "memoryNote_write"]; // derive-from-source seeding
    expect(door.writeDoorShapes(product, notAdmitted, "target", "h")).toEqual(product);
    expect(filter("template_pick", [NOTE_WRITER], notAdmitted, product, [])).toEqual([NOTE_WRITER]);
    expect(door.callerDeclaresWrite(["memoryNote_write"])).toBe(false);
    expect(door.callerDeclaresWrite(["apply_proposal_as_patch"])).toBe(true);
  });

  it("control: read shapes are unaffected", () => {
    const lines: string[] = [];
    expect(filter("template_pick", [READER], notAdmitted, [], lines)).toEqual([READER]);
    expect(door.writeDoorShapes(["config_file", "fileContent", "llmCompletion"], notAdmitted, "target", "h", (l) => lines.push(l))).toEqual(["config_file", "fileContent", "llmCompletion"]);
    expect(lines).toEqual([]);
  });
});
