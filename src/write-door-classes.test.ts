// THE WRITE DOORS, BEYOND THE FILESYSTEM (write-door.ts): on a goal not admitted as a change, a change shape (drafter,
// landing or mutating primitive) is never targeted, picked or composed, and a store write runs only as the goal's own
// product. Measured: a learned composition on a goal not admitted ran uiPanel_write, concept_write (from a composed
// child) and code_modification_proposal; a read-only goal was inferred ["config_file","apply_proposal_as_patch"].
// Namespace import, so on a module without the new helpers the assertions (not the link) fail.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as door from "./write-door";

// The writeDoorPolicy row is read from WORKSPACE_ROOT/policies/ (shaped-policy-store); every test here reads it under a
// root of its own, empty unless a test writes the row, so no host file steers these assertions.
const POLICY_ROOT = mkdtempSync(join(tmpdir(), "write-door-policy-"));
type PolicySeam = { configureWriteDoorPolicy?: (o: { workspaceRoot?: string; clock?: () => number }) => void };
const usePolicyRoot = (root: string): void => (door as unknown as PolicySeam).configureWriteDoorPolicy?.({ workspaceRoot: root });
const writePolicyRow = (root: string, row: unknown): void => {
  mkdirSync(join(root, "policies"), { recursive: true });
  writeFileSync(join(root, "policies", "writeDoorPolicy.json"), JSON.stringify(row));
};
afterAll(() => { rmSync(POLICY_ROOT, { recursive: true, force: true }); usePolicyRoot(undefined as unknown as string); });

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
  beforeEach(() => { door.resetWriteDoorCounters(); usePolicyRoot(POLICY_ROOT); });

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
    // Each is refused even as the goal's product, except a store product by policy (activity_create_variant by default),
    // which is refused whenever it is not the product.
    const { writeDoor } = door.taskWriteDoor(false, MINT_DISPATCH_PRIMITIVES.filter((s) => s !== "activity_create_variant"));
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
  it("must-fail: a task that writes only through its impulse-resolve pointer is refused by the pointer's type", () => {
    expect(typeof templateRefused).toBe("function");
    const POINTER_T = { id: "resolve-a-note", outputShapes: ["llm_completion"], tasks: [{ id: "a", resolver: "impulse_resolve", config: { pointer: { type: "memoryNote_write" } } }] };
    expect(templateRefused!(POINTER_T, false, "recovery_pick", "h", undefined, new Set(["llm_completion"]))).toBe(true);
    expect((door as unknown as { templateRunShapes?: (t: unknown) => string[] }).templateRunShapes?.(POINTER_T)).toContain("memoryNote_write");
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

  it("a declared activityTemplate_write is the dispatch's product: its task runs, and it stays a store write that admits no change", () => {
    // ribosome-vessel's extraction dispatch pins ribosome-extract and declares expected_output_shapes
    // ["activityTemplate_write"]: task 5 (impulse-resolve -> activityTemplate_write) is the write the run exists to
    // make. It must stay a STORE write: as a change shape (activityTemplate_deprecate is one) it would admit a change.
    const declared = ["activityTemplate_write"];
    const admitted = door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: declared });
    expect(admitted).toBe(false);
    expect(door.isWriteShape("activityTemplate_write")).toBe(false);
    expect(door.isStoreWrite("activityTemplate_write")).toBe(true);
    expect(door.taskWriteDoor(admitted, declared).writeDoor.governs("activityTemplate_write")).toBe(false);
    // Controls: undeclared, or another product declared, the same write is refused.
    expect(door.taskWriteDoor(admitted, []).writeDoor.governs("activityTemplate_write")).toBe(true);
    expect(door.taskWriteDoor(admitted, ["learningSummary"]).writeDoor.governs("activityTemplate_write")).toBe(true);
  });

  // User ruling 2026-10-27 ("Store product (Recommended)"), recorded as the shaped writeDoorPolicy whose default it is:
  // activity_create_variant is allowed when it is the goal's own declared product, and it does not admit the run as a
  // code or file change. The pattern drafter's register_variant step (a pinned dispatch declaring it) runs its write.
  const VARIANT: C = { id: "draft-activity-from-pattern", outputShapes: ["activity_create_variant"] };
  it("must-fail: by policy, a dispatch declaring activity_create_variant runs the variant write as its product and is not admitted as a change", () => {
    const declared = ["activity_create_variant"];
    expect(door.callerDeclaresWrite(declared)).toBe(false);
    const admitted = door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: declared });
    expect(admitted).toBe(false);
    const { writeDoor } = door.taskWriteDoor(admitted, declared);
    expect(writeDoor.governs("activity_create_variant")).toBe(false);
    // Not a code or file change: the run's other change writes stay refused.
    for (const s of ["fs_edit", "fs_write", "code_modification_proposal", "apply_proposal_as_patch", "variant_promote", "git_commit"]) {
      expect([s, writeDoor.governs(s)]).toEqual([s, true]);
    }
    expect(filter("template_pick", [VARIANT], admitted, declared, [])).toEqual([VARIANT]);
    expect(door.writeDoorShapes(declared, admitted, "target", "h")).toEqual(declared);
  });

  it("control: undeclared or not the product, activity_create_variant is refused; a non-write declaration admits nothing; fs/code writes admit as before", () => {
    const lines: string[] = [];
    for (const declared of [undefined, null, [] as string[]]) {
      expect(door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: declared })).toBe(false);
    }
    expect(filter("template_pick", [VARIANT], notAdmitted, [], lines)).toEqual([]);
    expect(door.taskWriteDoor(notAdmitted, []).writeDoor.governs("activity_create_variant")).toBe(true);
    // A goal whose product is something else gets no admission for a producer that writes a variant.
    expect(filter("template_pick", [VARIANT, READER], notAdmitted, ["resolver_pattern_report"], lines).map((c) => c.id)).toEqual([READER.id]);
    expect(door.taskWriteDoor(notAdmitted, ["resolver_pattern_report"]).writeDoor.governs("activity_create_variant")).toBe(true);
    for (const s of ["fileContent", "llmCompletion", "gapDecomposition", "memoryNote_write", "activityTemplate_write", "activityVariant_write"]) {
      expect([s, door.callerDeclaresWrite([s])]).toEqual([s, false]);
      expect([s, door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: [s] })]).toEqual([s, false]);
    }
    for (const s of ["fs_edit", "fs_write", "code_modification_proposal", "apply_proposal_as_patch", "feature_compose"]) {
      expect([s, door.callerDeclaresWrite([s])]).toEqual([s, true]);
    }
    // Declared beside a change shape, the change shape still admits the run.
    expect(door.callerDeclaresWrite(["activity_create_variant", "fs_edit"])).toBe(true);
  });

  it("control: the shaped row steers it: a writeDoorPolicy row classing it a change flips both results; a row cannot open a file write", () => {
    const root = mkdtempSync(join(tmpdir(), "write-door-policy-row-"));
    try {
      const declared = ["activity_create_variant"];
      writePolicyRow(root, { shapeClasses: { activity_create_variant: "change" } });
      usePolicyRoot(root);
      expect(door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: declared })).toBe(true);
      expect(door.taskWriteDoor(false, declared).writeDoor.governs("activity_create_variant")).toBe(true);
      // A row naming a filesystem write, a non-change shape or an unknown class is ignored.
      writePolicyRow(root, { shapeClasses: { activity_create_variant: "store_product", fs_edit: "store_product", memoryNote_write: "change", variant_promote: "maybe" } });
      usePolicyRoot(root);
      expect(door.taskWriteDoor(false, ["fs_edit", "variant_promote"]).writeDoor.governs("fs_edit")).toBe(true);
      expect(door.taskWriteDoor(false, ["fs_edit", "variant_promote"]).writeDoor.governs("variant_promote")).toBe(true);
      expect(door.callerDeclaresWrite(["memoryNote_write"])).toBe(false);
      expect(door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: declared })).toBe(false);
      // An unparseable row is the default (the ruling).
      writeFileSync(join(root, "policies", "writeDoorPolicy.json"), "{not json");
      usePolicyRoot(root);
      expect(door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: declared })).toBe(false);
      expect(door.taskWriteDoor(false, declared).writeDoor.governs("activity_create_variant")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      usePolicyRoot(POLICY_ROOT);
    }
  });

  it("control: the row is read at use time: a changed row takes effect after one policy window, with no restart", () => {
    const root = mkdtempSync(join(tmpdir(), "write-door-policy-ttl-"));
    let now = 1_000_000;
    try {
      (door as unknown as PolicySeam).configureWriteDoorPolicy?.({ workspaceRoot: root, clock: () => now });
      const declared = ["activity_create_variant"];
      expect(door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: declared })).toBe(false);
      writePolicyRow(root, { shapeClasses: { activity_create_variant: "change" } });
      now += 1_000; // inside the window: the cached classes still answer
      expect(door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: declared })).toBe(false);
      now += door.WRITE_DOOR_POLICY_TTL_MS; // past it: the row is read again
      expect(door.admittedChange({ admittedEditRoute: false, declaredOutputShapes: declared })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      (door as unknown as PolicySeam).configureWriteDoorPolicy?.({ workspaceRoot: POLICY_ROOT, clock: () => Date.now() });
    }
  });

  it("control: read shapes are unaffected", () => {
    const lines: string[] = [];
    expect(filter("template_pick", [READER], notAdmitted, [], lines)).toEqual([READER]);
    expect(door.writeDoorShapes(["config_file", "fileContent", "llmCompletion"], notAdmitted, "target", "h", (l) => lines.push(l))).toEqual(["config_file", "fileContent", "llmCompletion"]);
    expect(lines).toEqual([]);
  });
});
