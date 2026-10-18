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

  // Each of these dispatches to a drafter, mints or retires an activity, applies a disposition, or re-enters routing
  // (dispatch_goal: a child /run-goal), and none matches isMutationShape, so a goal not admitted could still run one
  // (gap_compose goes straight to development-vessel's resolveFeatureCompose and drafts a real edit).
  const MINT_DISPATCH_PRIMITIVES = [
    "gap_compose", "author_new_resolver", "author_producer", "author_composed_capability", "dispatch_goal",
    "vessel_mitosis_start", "template_repair", "variant_promote", "activity_create_variant", "activityTemplate_deprecate",
    "escalation_disposition_apply",
  ];
  it("must-fail: a not-admitted goal never picks, targets or runs a drafter, minting or re-dispatching primitive", () => {
    const lines: string[] = [];
    const GAP_COMPOSER: C = { id: "producer-of-gap_compose", outputShapes: ["gap_compose"] };
    expect(filter("template_pick", [GAP_COMPOSER, READER], notAdmitted, ["gap_compose", "resolver_pattern_report"], lines).map((c) => c.id)).toEqual([READER.id]);
    expect(door.writeDoorShapes(["dispatch_goal", "fileContent"], notAdmitted, "target", "h", (l) => lines.push(l))).toEqual(["fileContent"]);
    const { writeDoor } = door.taskWriteDoor(false, MINT_DISPATCH_PRIMITIVES);
    for (const s of MINT_DISPATCH_PRIMITIVES) {
      expect([s, door.isWriteShape(s)]).toEqual([s, true]);
      expect([s, writeDoor.governs(s)]).toEqual([s, true]);
    }
    expect(door.writeDoorShapes(MINT_DISPATCH_PRIMITIVES, true, "target", "h")).toEqual(MINT_DISPATCH_PRIMITIVES);
  });

  it("control: a question goal not admitted: the learned shellResult -> llm_completion -> memoryNote_write composition is refused, and its memoryNote_write task too", () => {
    // Measured live: "Check dispatch id ... What is this about?" ran this composition and its memoryNote_write task executed.
    const LEARNED: C = { id: "learned-composition-shellresult-to-llm-completion-to-memorynote-write", outputShapes: ["shellResult", "llm_completion", "memoryNote_write"] };
    const LLM: C = { id: "llm-completion", outputShapes: ["llm_completion"] };
    const lines: string[] = [];
    const product = ["llm_completion"]; // the question's own product: an answer, no note
    expect(filter("template_pick", [LEARNED, LLM], notAdmitted, product, lines).map((c) => c.id)).toEqual([LLM.id]);
    expect(lines[0]).toContain(`dropped ${LEARNED.id}: goal not admitted as a change (door=template_pick`);
    const { writeDoor } = door.taskWriteDoor(false, product);
    expect(writeDoor.governs("memoryNote_write")).toBe(true);
    expect(writeDoor.governs("shellResult")).toBe(false);
    expect(writeDoor.governs("llm_completion")).toBe(false);
  });

  it("must-fail: the re-dispatch, template-rewrite and directory-pruning primitives are change shapes too", () => {
    // dispatch_latest_auto_draft and goalDispatchAsync re-enter routing as dispatch_goal does; reachability_gap_repair
    // rewrites templates as template_repair does; prune_stale_mitosis deletes directories. All in the live vocabulary.
    const more = ["dispatch_latest_auto_draft", "goalDispatchAsync", "reachability_gap_repair", "prune_stale_mitosis"];
    const { writeDoor } = door.taskWriteDoor(false, more);
    for (const s of more) {
      expect([s, door.isWriteShape(s)]).toEqual([s, true]);
      expect([s, writeDoor.governs(s)]).toEqual([s, true]);
    }
  });

  // THE TEMPLATE DOOR: a fetched template is judged by its declared outputs AND its own tasks, so a template whose
  // declared outputs omit a writing task is excluded before it runs (the recovery loop's pinned known-reaching head),
  // rather than pinned and run with that task skipped by the executor.
  type T = { id: string; outputShapes?: string[]; tasks: Array<{ id: string; resolver: string; outputShapes?: string[] }> };
  const LEARNED_T: T = {
    id: "learned-composition-shellresult-to-llm-completion-to-memorynote-write", outputShapes: ["shellResult", "llm_completion", "memoryNote_write"],
    tasks: [{ id: "s1", resolver: "shellResult", outputShapes: ["shellResult"] }, { id: "s2", resolver: "llm_completion", outputShapes: ["llm_completion"] }, { id: "s3", resolver: "memoryNote_write", outputShapes: ["memoryNote_write"] }],
  };
  const UNDECLARED_T: T = { id: "declares-only-a-report", outputShapes: ["resolver_pattern_report"], tasks: [{ id: "a", resolver: "resolver_pattern_report" }, { id: "b", resolver: "uiPanel_write" }] };
  const READ_T: T = { id: "reads-only", outputShapes: ["llm_completion"], tasks: [{ id: "a", resolver: "shellResult" }, { id: "b", resolver: "llm_completion", outputShapes: ["llm_completion"] }] };
  const templateRefused = (door as unknown as { templateRefused?: (t: unknown, a: boolean, d: door.WriteDoor, h: string, r?: (l: string) => void, p?: ReadonlySet<string>) => boolean }).templateRefused;
  it("must-fail: a question goal not admitted: the learned composition as a known-reaching pathway head is refused before it is pinned", () => {
    expect(typeof templateRefused).toBe("function");
    const lines: string[] = [];
    const product = new Set(["llm_completion"]);
    expect(templateRefused!(LEARNED_T, false, "recovery_pick", "h", (l) => lines.push(l), product)).toBe(true);
    expect(lines[0]).toContain(`dropped ${LEARNED_T.id}: goal not admitted as a change (door=recovery_pick`);
    expect(door.writeDoorCounters().recovery_pick).toBe(1);
  });
  it("must-fail: a template whose declared outputs omit a writing task is refused by its tasks", () => {
    expect(typeof templateRefused).toBe("function");
    expect(templateRefused!(UNDECLARED_T, false, "template_pick", "h", undefined, new Set(["resolver_pattern_report"]))).toBe(true);
  });
  it("control: the template door keeps a reading template, every template on an admitted goal, a store write that is the product, and an unfetched template", () => {
    const keeps = (t: unknown, a: boolean, d: door.WriteDoor, p: string[]) => !(templateRefused?.(t, a, d, "h", undefined, new Set(p)) ?? false);
    expect(keeps(READ_T, false, "template_pick", ["llm_completion"])).toBe(true);
    expect(keeps(LEARNED_T, true, "recovery_pick", [])).toBe(true);
    expect(keeps(LEARNED_T, false, "recovery_pick", ["shellResult", "memoryNote_write"])).toBe(true);
    expect(keeps(null, false, "recovery_pick", [])).toBe(true);
    expect(door.writeDoorCounters().recovery_pick).toBe(0);
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
