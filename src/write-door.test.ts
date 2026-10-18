// THE WRITE DOORS (write-door.ts): a write shape is targeted, picked or composed only on a goal admitted as a
// change. The goal text is opaque to these helpers — admission is structural — so a read-only goal and an unseen
// wording behave identically: inferred ["fs_edit"] with no admission leaves no write candidate.
import { beforeEach, describe, expect, it } from "bun:test";

import { admittedChange, callerDeclaresWrite, isWriteShape, resetWriteDoorCounters, writeDoorCounters, writeDoorFilter, writeDoorShapes } from "./write-door";
import { FS_WRITE_SHAPES } from "./fs-write-shapes";

type C = { id: string; outputShapes: string[] };
const BRIDGE: C = { id: "auto-bridge-fs_edit", outputShapes: ["fs_edit"] };
const READER: C = { id: "read-source-file", outputShapes: ["fileContent"] };
const SHELL: C = { id: "shell-runner", outputShapes: ["shellResult"] };
const BYPRODUCT_WRITER: C = { id: "learned-csv-writer", outputShapes: ["llm_completion_result", "fileWriteResult"] };

const notAdmitted = admittedChange({ admittedEditRoute: false, declaredOutputShapes: undefined });

const pick = (goalHash: string, cands: C[], admitted: boolean, lines: string[]) =>
  writeDoorFilter(cands, (c) => c.outputShapes, admitted, "template_pick", goalHash, (l) => lines.push(l), (c) => c.id);

describe("write door", () => {
  beforeEach(() => resetWriteDoorCounters());

  it("must-fail: a not-admitted goal loses auto-bridge-fs_edit and every FS_WRITE_SHAPES producer, recorded and counted", () => {
    const lines: string[] = [];
    const writers = [...FS_WRITE_SHAPES].map((s) => ({ id: `producer-of-${s}`, outputShapes: [s] }));
    const kept = pick("588eed3c", [BRIDGE, READER, ...writers, SHELL], notAdmitted, lines);
    expect(kept.map((c) => c.id)).toEqual(["read-source-file", "shell-runner"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("[write-door] dropped auto-bridge-fs_edit,");
    expect(lines[0]).toContain("goal not admitted as a change (door=template_pick, goal_hash=588eed3c)");
    expect(writeDoorCounters().template_pick).toBe(1 + FS_WRITE_SHAPES.size);
  });

  it("must-fail: the composite door refuses a composite whose outputs write", () => {
    const lines: string[] = [];
    const kept = writeDoorFilter([{ id: "composed-cap-x", outputShapes: ["fileContent", "fs_edit"] }], (p) => p.outputShapes, notAdmitted, "composite_pick", "h", (l) => lines.push(l), (p) => p.id);
    expect(kept).toEqual([]);
    expect(lines[0]).toContain("dropped composed-cap-x");
    expect(writeDoorCounters().composite_pick).toBe(1);
  });

  it("must-fail: the read-only goal and an unseen wording, inferred ['fs_edit'], keep no write target or candidate", () => {
    for (const goal of [
      "Without modifying anything, describe what edits repos/goal-host-vessel/src/edge-blend.ts would need.",
      "leave the file untouched and tell me what would change",
    ]) {
      const lines: string[] = [];
      const ctx = { admittedEditRoute: false, declaredOutputShapes: [] as string[] }; // inferred, never declared
      const admitted = admittedChange(ctx);
      expect(admitted).toBe(false);
      expect(writeDoorShapes(["fs_edit"], admitted, "target", goal.length.toString(16), (l) => lines.push(l))).toEqual([]);
      expect(pick("h", [BRIDGE, BYPRODUCT_WRITER], admitted, lines)).toEqual([]);
      expect(lines.length).toBe(2);
    }
  });

  it("control: a goal admitted on the edit-intent route keeps fs_edit", () => {
    const lines: string[] = [];
    const admitted = admittedChange({ admittedEditRoute: true, declaredOutputShapes: null });
    expect(admitted).toBe(true);
    expect(pick("h", [BRIDGE, READER], admitted, lines).map((c) => c.id)).toEqual(["auto-bridge-fs_edit", "read-source-file"]);
    expect(writeDoorShapes(["fs_edit", "fileContent"], admitted, "target", "h")).toEqual(["fs_edit", "fileContent"]);
    expect(lines).toEqual([]);
    expect(Object.values(writeDoorCounters()).every((n) => n === 0)).toBe(true);
  });

  it("control: a caller-declared write shape is the structured signal and keeps fs_edit", () => {
    expect(callerDeclaresWrite(["fs_edit"])).toBe(true);
    expect(callerDeclaresWrite(["fileContent", "llm_completion_result"])).toBe(false);
    expect(callerDeclaresWrite(undefined)).toBe(false);
    const admitted = admittedChange({ admittedEditRoute: false, declaredOutputShapes: ["fileEditResult"] });
    expect(admitted).toBe(true);
    expect(pick("h", [BRIDGE], admitted, []).map((c) => c.id)).toEqual(["auto-bridge-fs_edit"]);
  });

  it("control: read shapes are unaffected on a not-admitted goal", () => {
    const lines: string[] = [];
    expect(pick("h", [READER, SHELL], notAdmitted, lines)).toEqual([READER, SHELL]);
    expect(writeDoorShapes(["fileContent", "shellResult", "llm_completion_result"], notAdmitted, "target", "h", (l) => lines.push(l))).toEqual(["fileContent", "shellResult", "llm_completion_result"]);
    expect(lines).toEqual([]);
    expect(isWriteShape("fs_read")).toBe(false);
    expect(isWriteShape("fs_edit")).toBe(true);
  });
});
