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
// WHAT A TEMPLATE WRITES, AT EVERY PICK THAT RUNS ONE (templateRunRefused): a pick's declared outputs are not what its
// run writes. Measured: a read question's template_pick door dropped learned-composition-test-suite-to-substrategap-
// write (discovery's row named substrateGap_write), then the composite author returned the same template as an
// existing composite with outputs [test_suite], and the composite door, judging those outputs only, let it run. So the
// composite door, the walk's execute step (every template_pick, bridge and composite pick reaches it with the template
// in hand) and the horizontal bundle judge templateRunShapes, the same shapes the executor's task door reads.
// ONCE REFUSED, REFUSED FOR THE DISPATCH (DoorRefusals): a template any door dropped is refused again whichever route
// re-offers it (the composite author, a retry walk, the recovery loop's pinned head or recommendation), keyed by the
// dispatch id and the normalised template id, and cleared at the dispatch's terminal record.
//
// The satisfier and vesselResolve keep their unconditional filesystem refusal (a walk-side write
// is uncreditable without a landed sha whatever the admission); on a goal not admitted they also
// refuse the rest of the class, and every refusal is counted here.
import { isFsWriteShape } from "./fs-write-shapes";
import { isMutationShape } from "./judge/shapes";

/**
 * Drafter / landing shapes, the mutating primitives (git, GitHub, units, database, the tree), and the primitives that
 * draft, mint, retire, apply or re-dispatch (none of them matches isMutationShape): gap_compose goes straight to
 * development-vessel's feature compose; dispatch_goal, dispatch_latest_auto_draft and goalDispatchAsync are a child
 * /run-goal that re-enters routing with its own admission; template_repair and reachability_gap_repair rewrite
 * templates; prune_stale_mitosis deletes directories. Classified BY NAME, the second half a copy of
 * development-vessel's MUTATING_PRIMITIVES (named debt: write-ness belongs in declared shape metadata, not in two
 * hand-kept lists; this list is what that retires).
 */
export const CHANGE_PRIMITIVE_SHAPES: ReadonlySet<string> = new Set([
  "code_modification_proposal", "code_modification_proposal_write", "feature_compose", "patch_with_tools", "apply_proposal_as_patch",
  "gap_compose", "author_new_resolver", "author_producer", "author_composed_capability",
  "dispatch_goal", "dispatch_latest_auto_draft", "goalDispatchAsync",
  "vessel_mitosis_start", "prune_stale_mitosis", "template_repair", "reachability_gap_repair", "variant_promote",
  "activity_create_variant", "activityTemplate_deprecate", "escalation_disposition_apply",
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
  // Every change shape a caller declares admits the dispatch, activity_create_variant included (user ruling 2026-10-25:
  // it is a change, not a declarable store product, so a pinned drafter that declares it runs its variant write).
  // Undeclared, it is still refused like every change shape.
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

/** The shape an http_fetch task writes when its request is opaque (see fetchedResolveWrites): refused like a store write. */
export const OPAQUE_RESOLVE_WRITE = "opaque_resolve_write";

/** A URL whose path is an impulse resolve endpoint (/v2/impulses/resolve, or discovery's /resolve), on any host. */
const RESOLVE_PATH = /\/(?:v2\/impulses\/)?resolve\/?(?:[?#]|$)/;

/**
 * THE WRITE A FETCH CARRIES: an http_fetch task that POSTs an impulse to a resolve URL writes the impulse's type, exactly
 * like a native task of that type (measured class: a composition's http_fetch POST of {impulse:{type:
 * "substrateGap_write"}} is a gap write the resolver id alone does not name). The request is read from the task's
 * config (or config.pointer): GET and HEAD send nothing; a POST to any other URL is not judged here. Fail closed: a
 * method or URL that is a placeholder, or a resolve POST whose body is absent, unparseable or names no literal type
 * (a `{{…}}` value could bind to any type at run time, and this door judges the template before binding), writes
 * OPAQUE_RESOLVE_WRITE. The read types it names (a resolve of a read shape) are returned too and refused by nothing.
 */
export function fetchedResolveWrites(task: unknown): string[] {
  const k = (task ?? {}) as { resolver?: unknown; config?: Record<string, unknown> };
  const config = k.config && typeof k.config === "object" ? k.config : {};
  const resolver = typeof k.resolver === "string" ? k.resolver.replace(/\/[^/]*$/, "") : "";
  const pointer = config.pointer && typeof config.pointer === "object" ? (config.pointer as Record<string, unknown>) : null;
  if (resolver !== "http_fetch" && config.type !== "http_fetch" && pointer?.type !== "http_fetch") return [];
  const req = pointer && ("url" in pointer || "body" in pointer || "method" in pointer) ? pointer : config;
  const opaque = (v: unknown): boolean => typeof v === "string" && v.includes("{{");
  const method = req.method === undefined ? "GET" : req.method;
  if (typeof method !== "string" || opaque(method)) return [OPAQUE_RESOLVE_WRITE];
  if (/^(GET|HEAD)$/i.test(method.trim())) return [];
  const url = req.url;
  if (typeof url !== "string" || opaque(url)) return [OPAQUE_RESOLVE_WRITE];
  if (!RESOLVE_PATH.test(url)) return [];
  let body: unknown = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return [OPAQUE_RESOLVE_WRITE]; }
  }
  if (!body || typeof body !== "object") return [OPAQUE_RESOLVE_WRITE];
  const b = body as { type?: unknown; impulse?: { type?: unknown; pointer?: { type?: unknown } }; pointer?: { type?: unknown } };
  const named = [b.impulse?.type, b.impulse?.pointer?.type, b.pointer?.type, b.type].filter((v) => v !== undefined);
  if (named.length === 0 || named.some((v) => typeof v !== "string" || !v || opaque(v))) return [OPAQUE_RESOLVE_WRITE];
  return [...new Set(named as string[])];
}

/**
 * Every shape a template run produces: its declared outputs and each task's resolver id (and the shape it serves, the
 * id less a `/kind` suffix), config.pointer.type, outputs, and the impulse type an http_fetch task POSTs to a resolve URL
 * (what the executor's task door reads; a vessel resolver is registered under the shape it serves, and an impulse-
 * resolve task writes the type of the pointer it sends).
 */
export function templateRunShapes(template: unknown): string[] {
  const t = (template ?? {}) as { outputShapes?: unknown; output_shapes?: unknown; tasks?: unknown };
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : []);
  const shapes = [...list(t.outputShapes), ...list(t.output_shapes)];
  for (const task of Array.isArray(t.tasks) ? t.tasks : []) {
    const k = (task ?? {}) as { resolver?: unknown; outputShapes?: unknown; config?: { pointer?: { type?: unknown } } };
    if (typeof k.resolver === "string" && k.resolver !== "compose" && k.resolver !== "compose_parallel") {
      shapes.push(k.resolver);
      const served = k.resolver.replace(/\/[^/]*$/, "");
      if (served && served !== k.resolver) shapes.push(served);
    }
    const pointerType = k.config?.pointer?.type; // the pointer an impulse-resolve task sends
    if (typeof pointerType === "string" && pointerType) shapes.push(pointerType);
    shapes.push(...list(k.outputShapes), ...fetchedResolveWrites(task));
  }
  return [...new Set(shapes)];
}

/**
 * The template door: on a goal not admitted, a fetched template whose declared outputs or own tasks are refused is not
 * run, so the caller excludes it and tries another, instead of running it with its writing tasks skipped. Counted and
 * recorded like every door. A template that could not be fetched is not judged here (the task door still holds).
 */
export function templateRefused(template: unknown, admitted: boolean, door: WriteDoor, goalHash: string, record?: (line: string) => void, goalProduct?: ReadonlySet<string> | null): boolean {
  if (admitted || !template) return false;
  const id = String((template as { id?: unknown }).id ?? "template");
  return writeDoorFilter([template], templateRunShapes, false, door, goalHash, record, () => id, goalProduct).length === 0;
}

/** The executor's task-level door (ias-executor-ts ExecuteOptions.writeDoor): same predicate, same goal product. */
export interface TaskWriteDoor { admitted: boolean; governs: (shape: string) => boolean }

/** Spread into a template run's options. A spread, so an executor dist without the field still typechecks. */
export function taskWriteDoor(admitted: boolean, goalProduct: Iterable<string>): { writeDoor: TaskWriteDoor } {
  const product = new Set(goalProduct);
  return { writeDoor: { admitted, governs: (shape: string) => refusedWrite(shape, product) } };
}

/** A template id as every door keys it: the activity:⟨…⟩ wrapper stripped (the composite author returns it wrapped). */
export function doorTemplateKey(id: string): string {
  return id.replace(/^activity:/, "").replace(/[⟨⟩]/g, "").trim();
}

/** The templates a door refused in one dispatch (normalised ids). */
export class RefusedTemplates {
  private readonly ids = new Set<string>();
  add(id: string): void { const k = doorTemplateKey(id); if (k) this.ids.add(k); }
  has(id: string): boolean { return this.ids.has(doorTemplateKey(id)); }
  list(): string[] { return [...this.ids]; }
  /** Record every item a door filter dropped: those of `before` not in `kept`. */
  noteDropped<T>(before: readonly T[], kept: readonly T[], idOf: (item: T) => string): void {
    for (const item of before) if (!kept.includes(item)) this.add(idOf(item));
  }
}

/** Per-dispatch refusals, bounded like the walk's other per-dispatch records; taken at the terminal record write. */
export class DoorRefusals {
  private byDispatch = new Map<string, RefusedTemplates>();
  constructor(private readonly cap = 256) {}
  /** The dispatch's record (created on first use). No dispatch id: a fresh record the caller alone holds. */
  forDispatch(dispatchId: string): RefusedTemplates {
    if (!dispatchId) return new RefusedTemplates();
    let r = this.byDispatch.get(dispatchId);
    if (!r) {
      if (this.byDispatch.size >= this.cap) { const oldest = this.byDispatch.keys().next().value; if (oldest !== undefined) this.byDispatch.delete(oldest); }
      r = new RefusedTemplates();
      this.byDispatch.set(dispatchId, r);
    }
    return r;
  }
  take(dispatchId: string): void { this.byDispatch.delete(dispatchId); }
}

/**
 * The run door: on a goal not admitted, is running template `id` refused? Refused when a door already refused it in
 * this dispatch, or when its declared outputs or any shape its run writes (templateRunShapes of the loaded template)
 * are refused. A refusal is counted under `door`, recorded, and added to `refused`. A template that cannot be loaded
 * is judged by its declared outputs alone (the task door still holds) and the line says it was unjudged.
 */
export async function templateRunRefused(
  id: string,
  declaredOutputs: readonly string[],
  loadTemplate: () => Promise<unknown>,
  admitted: boolean,
  door: WriteDoor,
  refused: RefusedTemplates,
  goalHash: string,
  record?: (line: string) => void,
  goalProduct?: ReadonlySet<string> | null,
): Promise<boolean> {
  if (admitted) return false;
  const key = doorTemplateKey(id);
  if (refused.has(key)) {
    counters[door] += 1;
    record?.(`${writeDropLine(door, [key], goalHash)}; already refused in this dispatch`);
    return true;
  }
  let template: unknown = null;
  try { template = await loadTemplate(); } catch (e) { template = null; record?.(`[write-door] ${door}: ${key} tasks unjudged: template unloadable (${String((e as Error)?.message ?? e).slice(0, 80)})`); }
  const shapes = [...declaredOutputs, ...(template ? templateRunShapes(template) : [])];
  if (writeDoorFilter([key], () => shapes, false, door, goalHash, record, String, goalProduct).length > 0) return false;
  refused.add(key);
  return true;
}
