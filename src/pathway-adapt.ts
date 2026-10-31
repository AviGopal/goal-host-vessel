// FIRST/LAST-MILE ADAPTATION OF A RECOMMENDED PATHWAY (the execution contract's middle tier).
//
// recommendReachingPath returns the whole ordered pathway, but the walk read it only as a tie-break among candidates
// that are already feasible AND already advance a missing target. A near-variant of a reached goal therefore re-derived:
// a body step that discover did not return was never a candidate, and a body step whose output is an intermediate
// (the exit to a different target shape is the walk's to find) never "advances" the target. This module decides, once
// per walk, whether the pathway is a near-variant and which of its TEMPLATE steps the walk may take as body steps:
//   first_mile: the body's entry is not bindable from the current pool (different inputs; the walk produces them);
//   last_mile:  the body covers fewer than all of the goal's missing targets, none included (different exit; the walk
//               carries the body's outputs on);
//   exact:      neither, so the ceiling path stays as it was (no merge, no tag).
// `satisfier:<shape>` steps are never taken here: the satisfier plane keeps its own order (reuse ordering is off on
// measured harm, index.ts). An unreadable template step is skipped with its reason; the walk is otherwise unchanged.

export type AdaptStep = { id: string; inputShapes: string[]; outputShapes: string[] };
export type AdaptMode = "first_mile" | "last_mile" | "first_mile+last_mile";
export type AdaptPlan = { mode: AdaptMode | "exact" | null; steps: AdaptStep[]; skipped: Array<{ id: string; why: string }> };

const bare = (id: string) => id.replace(/^activity:/, "").replace(/[⟨⟩]/g, "").trim();
const shapes = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

/** Classify `activities` (the recommended pathway, in order) against the goal's targets and the pool it starts from. */
export async function planAdaptation(
  activities: readonly unknown[] | null | undefined,
  targets: readonly string[],
  pool: ReadonlySet<string>,
  getTemplate: (bareId: string) => Promise<unknown | null>,
): Promise<AdaptPlan> {
  const steps: AdaptStep[] = [];
  const skipped: AdaptPlan["skipped"] = [];
  const out = new Set<string>();
  for (const a of activities ?? []) {
    const id = bare(String(a ?? ""));
    if (!id || id === "universal-tool-fallback") continue;
    if (id.startsWith("satisfier:")) { out.add(id.slice("satisfier:".length)); continue; }
    const t = (await getTemplate(id).catch(() => null)) as Record<string, unknown> | null;
    if (!t) { skipped.push({ id, why: "template unreadable" }); continue; }
    const optional = shapes(t["optional_input_shapes"] ?? t["optionalInputShapes"]);
    const inputShapes = shapes(t["inputShapes"] ?? t["input_shapes"]).filter((s) => !optional.includes(s));
    const outputShapes = shapes(t["outputShapes"] ?? t["output_shapes"]);
    steps.push({ id, inputShapes, outputShapes });
  }
  // The old exit: a step whose outputs neither the goal nor a later step reads is not part of this goal's body. ONE pass,
  // by intent: it drops only the trailing step(s) nothing reads; a step another kept step reads stays in the body.
  const body = steps.filter((s, i) => {
    const used = s.outputShapes.some((x) => targets.includes(x) || steps.slice(i + 1).some((l) => l.inputShapes.includes(x)));
    if (!used) skipped.push({ id: s.id, why: "the pathway's old exit: no output the goal or a later step reads" });
    return used;
  });
  if (body.length === 0) return { mode: null, steps: body, skipped };
  let entryMissing = false;
  for (const s of body) {
    if (s.inputShapes.some((x) => !pool.has(x) && !out.has(x))) entryMissing = true;
    for (const x of s.outputShapes) out.add(x);
  }
  const missing = targets.filter((s) => !pool.has(s));
  const covered = missing.filter((s) => out.has(s));
  // A body that covers NONE of the missing targets is still the last mile (same body, its outputs carried to a different
  // target shape). Exact only when the body covers every missing target.
  const lastMile = body.length > 0 && covered.length < missing.length;
  const mode: AdaptPlan["mode"] = entryMissing && lastMile ? "first_mile+last_mile" : entryMissing ? "first_mile" : lastMile ? "last_mile" : "exact";
  return { mode, steps: body, skipped };
}

/** The next body step the walk may take now: the first not yet run whose inputs the pool binds and that adds a shape. */
export function nextBodyStep(plan: AdaptPlan, done: (bareId: string) => boolean, pool: ReadonlySet<string>): AdaptStep | null {
  if (plan.mode === null || plan.mode === "exact") return null;
  return plan.steps.find((s) => !done(s.id) && s.inputShapes.every((x) => pool.has(x)) && s.outputShapes.some((x) => x !== "activityExecutionSummary" && !pool.has(x))) ?? null;
}
