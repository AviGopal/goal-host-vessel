// THE EDIT-INTENT ROUTE SWITCH, AS A SHAPED RECORD (law 1: behaviour is read from shaped impulses at use time, never
// from an env var frozen at process start).
//
// A goal that names a repos/<vessel>/<path> file with an edit verb used to be handed to feature_compose before the walk
// whenever the env switch ROUTE_EDIT_INTENT_TO_COMPOSE was not "0". The switch is now the activityVariantMask pool
// record for the activity "goal-host-vessel:edit-intent-route", read once per dispatch:
//   - variant 0 (the control), no record in force, an unreadable pool, an unknown variant: route to feature_compose,
//     exactly as before;
//   - variant 1: no feature_compose hand-off (neither the early route nor the late one). The goal is still a change:
//     the dispatch is admitted as one and walks with the landing shape (LANDING_TARGET_SHAPE) seeded as a target, so
//     backward-chaining has somewhere to start (patch_with_tools lands in process; a staged patch is landed by
//     development-vessel:mitosis-tick).
//
// NO DOUBLE LANDING (inProcessLanding): patch_with_tools drafts, verifies AND lands in its own process, and says so in
// its output body (landed / new_git_sha). A walk that targets the landing shape treats such an output as the landing
// itself, so it never runs a second landing step (mitosis-tick / vessel_mitosis_cutover) for the same change.

export const EDIT_INTENT_ROUTE_ACTIVITY = "goal-host-vessel:edit-intent-route";
/** The walk target a variant-1 change goal is seeded with: the landing development-vessel's cutover reports. */
export const LANDING_TARGET_SHAPE = "cutoverApplied";
const EDIT_INTENT_ROUTE_VARIANTS = [0, 1] as const;

export type EditIntentMaskState = "in_force" | "no_mask" | "unread";
export interface EditIntentRouteDecision {
  /** 0 = route to feature_compose (control); 1 = walk the change instead. */
  variant: number;
  /** the hand-off may route to feature_compose (variant !== 1) */
  route_enabled: boolean;
  mask_id: string | null;
  mask_state: EditIntentMaskState;
  why: string;
}

type MaskRow = { id?: string; body?: unknown };

/** The variant in force at `nowIso` from the open activityVariantMask rows: the first row for the edit-intent route
 *  whose [from, until) holds now. Rows unread (null): variant 0. No row in force: variant 0. Unknown variant: 0. */
export function editIntentRouteDecision(nowIso: string, rows: readonly MaskRow[] | null): EditIntentRouteDecision {
  const done = (variant: number, mask_id: string | null, mask_state: EditIntentMaskState, why: string): EditIntentRouteDecision =>
    ({ variant, route_enabled: variant !== 1, mask_id, mask_state, why });
  if (rows === null) return done(0, null, "unread", "mask pool unread: variant-0");
  const now = Date.parse(nowIso);
  for (const r of rows) {
    const b = (r?.body ?? {}) as Record<string, unknown>;
    if (b["activity_id"] !== EDIT_INTENT_ROUTE_ACTIVITY) continue;
    const from = Date.parse(String(b["from"] ?? "")), until = Date.parse(String(b["until"] ?? ""));
    if (!Number.isFinite(from) || !Number.isFinite(until) || now < from || now >= until) continue;
    const id = r?.id === undefined ? null : String(r.id);
    const v = b["active_variant"];
    if (typeof v !== "number" || !(EDIT_INTENT_ROUTE_VARIANTS as readonly number[]).includes(v)) {
      return done(0, id, "in_force", `mask ${String(id)} names unknown variant ${JSON.stringify(v)}: variant-0`);
    }
    return done(v, id, "in_force", `mask ${String(id)} [${String(b["from"])}, ${String(b["until"])}) by ${String(b["by"])}: ${String(b["reason"])}`);
  }
  return done(0, null, "no_mask", "no mask in force: variant-0");
}

/** The one log line per decision (mask id, state, why), as the dispatch's decision log carries it. */
export function editIntentRouteLine(surface: string, d: EditIntentRouteDecision): string {
  return `[goal-host-vessel] ${surface}: edit-intent-route variant=${d.variant} route=${d.route_enabled ? "feature_compose" : "walk"} ` +
    JSON.stringify({ mask_id: d.mask_id, mask_state: d.mask_state, why: d.why });
}

/** The walk targets of a variant-1 change goal: the dispatch's targets plus the landing shape (deduplicated). */
export function withLandingTarget(shapes: readonly string[] | null | undefined, unproducible: (shape: string) => boolean = () => false): string[] {
  // A walk-side filesystem write is refused at every door (fs-write-shapes.ts), so a target such as fs_edit could never
  // be met: it is dropped, and the landing is the change's target.
  const out = (shapes ?? []).filter((s) => !unproducible(s));
  if (!out.includes(LANDING_TARGET_SHAPE)) out.push(LANDING_TARGET_SHAPE);
  return out;
}

/** A step output that already LANDED in process (patch_with_tools): `landed === true` or a non-empty `new_git_sha`,
 *  on the content itself or on its `body` / `content` / `result` wrapper. Evidence of a landing, nothing else. */
export function inProcessLanding(content: unknown): { landed: boolean; new_git_sha: string | null } {
  const levels: unknown[] = [content];
  if (content && typeof content === "object") {
    const o = content as Record<string, unknown>;
    levels.push(o["body"], o["content"], o["result"]);
  }
  for (const l of levels) {
    if (!l || typeof l !== "object" || Array.isArray(l)) continue;
    const o = l as Record<string, unknown>;
    const sha = typeof o["new_git_sha"] === "string" && o["new_git_sha"].trim() !== "" ? o["new_git_sha"].trim() : null;
    if (o["landed"] === true || sha) return { landed: true, new_git_sha: sha };
  }
  return { landed: false, new_git_sha: null };
}

/** The shapes a step that lands IN PROCESS produces: patch_with_tools' result (mitosisStaged, with landed / new_git_sha
 *  from its own cutover) and the primitive itself when the walk keys its output by the primitive's name. A read step's
 *  output (an old landing record, a cutover report, a gap or trace row) may carry landed or new_git_sha too, and is
 *  never landing evidence: counting it would let a walk reach with no landing. */
export const IN_PROCESS_LANDING_SHAPES: ReadonlySet<string> = new Set(["mitosisStaged", "patch_with_tools"]);

/** Does this step's output satisfy the walk's landing target? Only when it was produced by a step of THIS walk (a
 *  seeded impulse, from the standing pool or a caller variable, may carry an earlier dispatch's landing), the walk
 *  targets the landing shape and has not produced it yet, the step's shape is one that lands in process, and its output
 *  carries the landing evidence. */
export function landingSatisfiedBy(shape: string, content: unknown, walkTargets: ReadonlySet<string>, produced: ReadonlySet<string>, producedBy: string | undefined): boolean {
  return typeof producedBy === "string" && producedBy !== "" && producedBy !== "seed" && IN_PROCESS_LANDING_SHAPES.has(shape) && walkTargets.has(LANDING_TARGET_SHAPE) && !produced.has(LANDING_TARGET_SHAPE) && inProcessLanding(content).landed;
}
