// THE WRITE DOORS: a CHANGE shape is picked, composed or targeted ONLY on a goal ADMITTED as a change, and a
// STORE write is run on a goal not admitted only when it is that goal's own product.
//
// Measured: "Without modifying anything, describe what edits <file> would need." was inferred
// ["fs_edit"], and the walk ran auto-bridge-fs_edit twice against the live tree — an ordinary
// template pick, then the composite path ("COMPOSED existing capability … missing_target"). Only
// a downstream path guard stopped it. FS_WRITE_SHAPES held at the satisfier and vesselResolve
// and nowhere a template or composite was chosen, so inference alone could open a write.
// Then, with that door in place: a system-generated walk on a goal not admitted as a change ran a
// learned composition whose own tasks wrote uiPanel_write, concept_write (from a composed child)
// and code_modification_proposal. Template-internal tasks are not walk picks, so no walk door saw
// them; and a read-only goal was inferred ["config_file","apply_proposal_as_patch"], which no door
// held because apply_proposal_as_patch is not a filesystem shape.
//
// THE CLASSES (one predicate, refusedWrite, used by every door here and handed to the executor):
//   change — FS_WRITE_SHAPES (fs-write-shapes.ts) plus CHANGE_PRIMITIVE_SHAPES: the drafter and
//            landing shapes (code_modification_proposal, feature_compose, patch_with_tools,
//            apply_proposal_as_patch), the primitives that draft, mint, retire, apply or re-dispatch
//            (gap_compose, author_*, template_repair, variant_promote, dispatch_goal, …), and the
//            git / GitHub / unit / database / tree primitives,
//            the set development-vessel's caller-credential gate names as MUTATING_PRIMITIVES
//            (minus http_fetch, gated there for its fleet key, not because it writes). A change
//            shape needs ADMISSION, at every door including the target door.
//   store  — the rest of judge/shapes.ts isMutationShape: *_write, write_note, *_update/_create/
//            _delete (uiPanel_write, concept_write, memoryNote_write, substrateGap_write, …). A store
//            write is refused on a goal not admitted UNLESS it is that goal's own product: one of
//            the walk's targets (inferred or declared) or terminal shapes. A target is never
//            dropped for being a store write: the store-intent override and the derive-from-source
//            seeding insert memoryNote_write as the target before the dispatch's target door runs,
//            and the transform oracle reads that note back, so the target is the graded artifact.
//            What is refused is the side effect: a store write a producer makes that the goal never
//            asked for.
//   read   — everything else, gapDecomposition included (a gap investigation's oracle-graded
//            product; its lease is taken inside the drafter's own resolver, never by a walk task).
// WALK_MECHANICS_WRITES stay allowed whatever the goal: poolImpulse_write is how a human's
// injected impulse reaches a running walk. The system's own records (traces, gap filings, the
// reach expectation notes, lifecycle subscriber runs) never pass a door: they are direct calls
// or run without a write door.
//
// Admission is structural, never read from the goal's wording: either the dispatch entered the
// edit-intent route to feature_compose (the routing rules' own decision), or the CALLER declared
// a change shape in expected_output_shapes. goal-host has no other structured write field, so the
// caller-declared shapes are that signal. A declared store write admits nothing: it is a target,
// and so the goal's product. Every drop is recorded (tagged line) and counted (writeDoorCounters,
// on /health).
//
// TASK LEVEL (taskWriteDoor): the same predicate goes to ias-executor-ts with every template run
// (ExecuteOptions.writeDoor), and the engine skips and records any task whose resolver or output
// shape it refuses, in composed children too. An executor that predates the option ignores it and
// runs every task (its documented default when the option is absent), so /health shows the
// executor's own drop counts as null there.
//
// The satisfier and vesselResolve keep their unconditional filesystem refusal (a walk-side write
// is uncreditable without a landed sha whatever the admission); on a goal not admitted they also
// refuse the rest of the class, and every refusal is counted here.
import { isFsWriteShape } from "./fs-write-shapes";
import { isMutationShape } from "./judge/shapes";

/**
 * Drafter / landing shapes, the mutating primitives (git, GitHub, units, database, the tree), and the primitives that
 * draft, mint, retire, apply or re-dispatch (none of them matches isMutationShape): gap_compose goes straight to
 * development-vessel's feature compose; dispatch_goal is a child /run-goal that re-enters routing with its own
 * admission. Classified BY NAME, the second half a copy of development-vessel's MUTATING_PRIMITIVES (named debt:
 * write-ness belongs in declared shape metadata, not in two hand-kept lists).
 */
export const CHANGE_PRIMITIVE_SHAPES: ReadonlySet<string> = new Set([
  "code_modification_proposal", "code_modification_proposal_write", "feature_compose", "patch_with_tools", "apply_proposal_as_patch",
  "gap_compose", "author_new_resolver", "author_producer", "author_composed_capability", "dispatch_goal",
  "vessel_mitosis_start", "template_repair", "variant_promote", "activity_create_variant", "activityTemplate_deprecate",
  "escalation_disposition_apply",
  "git_add", "git_commit", "git_push", "git_branch_create", "gh_pr_create", "gh_pr_merge", "gh_repo_create",
  "systemd_restart", "pull_cutover", "surrealdb_import", "activate_substrate_script", "vessel_mitosis_cutover",
]);

/** Store writes the walk's own mechanics make, allowed whatever the goal. */
export const WALK_MECHANICS_WRITES: ReadonlySet<string> = new Set(["poolImpulse_write"]);

/** A CHANGE shape: only a goal admitted as a change may target, pick, compose or run it. */
export function isWriteShape(shape: unknown): boolean {
  return isFsWriteShape(shape) || (typeof shape === "string" && CHANGE_PRIMITIVE_SHAPES.has(shape));
}

/** A store write (the rest of isMutationShape): allowed on a goal not admitted only as its own product. */
export function isStoreWrite(shape: unknown): boolean {
  return typeof shape === "string" && !isWriteShape(shape) && isMutationShape(shape) && !WALK_MECHANICS_WRITES.has(shape);
}

/** On a goal NOT admitted as a change: is producing `shape` refused? `goalProduct` = the goal's targets. */
export function refusedWrite(shape: unknown, goalProduct?: ReadonlySet<string> | null): boolean {
  if (isWriteShape(shape)) return true;
  return isStoreWrite(shape) && !(goalProduct?.has(shape as string) ?? false);
}

export interface WriteDoorContext {
  /** The dispatch was handed to feature_compose by the early edit-intent route. */
  admittedEditRoute: boolean;
  /** The caller's own expected_output_shapes, before any inference. */
  declaredOutputShapes?: readonly string[] | null;
}

export function callerDeclaresWrite(declared: readonly string[] | null | undefined): boolean {
  return Array.isArray(declared) && declared.some((s) => isWriteShape(s));
}

export function admittedChange(ctx: WriteDoorContext): boolean {
  return ctx.admittedEditRoute === true || callerDeclaresWrite(ctx.declaredOutputShapes);
}

export type WriteDoor =
  | "target" | "template_pick" | "composite_pick" | "bridge_pick" | "recovery_pick"
  | "satisfier" | "vessel_resolve";

const counters: Record<WriteDoor, number> = {
  target: 0, template_pick: 0, composite_pick: 0, bridge_pick: 0, recovery_pick: 0,
  satisfier: 0, vessel_resolve: 0,
};
export function writeDoorCounters(): Readonly<Record<WriteDoor, number>> { return { ...counters }; }
export function resetWriteDoorCounters(): void { for (const k of Object.keys(counters) as WriteDoor[]) counters[k] = 0; }
/** The unconditional doors (satisfier, vesselResolve) count their refusals here. */
export function noteWriteRefusal(door: WriteDoor, n = 1): void { counters[door] += n; }

export function writeDropLine(door: WriteDoor, dropped: readonly string[], goalHash: string): string {
  return `[write-door] dropped ${dropped.join(",")}: goal not admitted as a change (door=${door}, goal_hash=${goalHash})`;
}

/**
 * Keep every item that writes nothing; keep a writing item only when the goal is admitted.
 * An item writes when any shape `shapesOf` returns is refused (refusedWrite: a change shape, or a
 * store write outside `goalProduct`). Each dropped item is counted and named in one recorded line.
 */
export function writeDoorFilter<T>(
  items: readonly T[],
  shapesOf: (item: T) => readonly string[],
  admitted: boolean,
  door: WriteDoor,
  goalHash: string,
  record?: (line: string) => void,
  nameOf: (item: T) => string = (item) => String(item),
  goalProduct?: ReadonlySet<string> | null,
): T[] {
  if (admitted) return [...items];
  const kept: T[] = [];
  const dropped: string[] = [];
  for (const item of items) {
    if (shapesOf(item).some((s) => refusedWrite(s, goalProduct))) dropped.push(nameOf(item));
    else kept.push(item);
  }
  if (dropped.length > 0) {
    counters[door] += dropped.length;
    record?.(writeDropLine(door, dropped, goalHash));
  }
  return kept;
}

/** A door's admission, carried to a picker that runs outside the walk (the recovery loop's recommend). */
export interface WriteDoorPass { admitted: boolean; goalHash: string; record?: (line: string) => void }

/**
 * The target form: a list of shapes, each its own item. A target list IS the goal's product, so by
 * default only change shapes drop from it; pass `goalProduct` when the list is not the goal's own
 * targets (a producer's inputs).
 */
export function writeDoorShapes(shapes: readonly string[], admitted: boolean, door: WriteDoor, goalHash: string, record?: (line: string) => void, goalProduct?: ReadonlySet<string> | null): string[] {
  return writeDoorFilter(shapes, (s) => [s], admitted, door, goalHash, record, String, goalProduct ?? new Set(shapes));
}

/** The executor's task-level door (ias-executor-ts ExecuteOptions.writeDoor): same predicate, same goal product. */
export interface TaskWriteDoor { admitted: boolean; governs: (shape: string) => boolean }

/** Spread into a template run's options. A spread, so an executor dist without the field still typechecks. */
export function taskWriteDoor(admitted: boolean, goalProduct: Iterable<string>): { writeDoor: TaskWriteDoor } {
  const product = new Set(goalProduct);
  return { writeDoor: { admitted, governs: (shape: string) => refusedWrite(shape, product) } };
}
