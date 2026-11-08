// A CHANGE GOAL IS WALKED. A goal that names a repos/<vessel>/<path> file with an edit verb (the edit-intent routing
// rules' decision) is admitted as a change and walks with the landing shape (LANDING_TARGET_SHAPE) seeded as a target,
// so backward-chaining has somewhere to start (patch_with_tools lands in process; a staged patch is landed by
// development-vessel:mitosis-tick). There is no compose hand-off: the walk is the change's only route.
//
// NO DOUBLE LANDING (inProcessLanding): patch_with_tools drafts, verifies AND lands in its own process, and says so in
// its output body (landed / new_git_sha). A walk that targets the landing shape treats such an output as the landing
// itself, so it never runs a second landing step (mitosis-tick / vessel_mitosis_cutover) for the same change.

/** The walk target a change goal is seeded with: the landing development-vessel's cutover reports. */
export const LANDING_TARGET_SHAPE = "cutoverApplied";

/** The walk targets of a change goal: the dispatch's targets plus the landing shape (deduplicated). */
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
