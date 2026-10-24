// AN UNREGISTERED STEP IS NOT A PICK: a template, or a learned or composed chain, whose step resolver nothing serves is
// ineligible at the walk's pick, before it is dispatched, and the reason is recorded as a shape.
//
// Measured: about 40% of walk failure time was walks bridging through `source_code`, a shape no vessel registers in
// discovery any more (its resolver was removed deliberately). The picks were auto-bridge-source_code (one task,
// resolver: source_code, input_shapes [] so it is feasible for any goal) and the learned / composed chains built over
// it. Each one was fetched, dispatched, and failed inside the executor with "Resolver 'source_code' is not registered";
// the walk then excluded it and the next walk picked it again. The candidate rows the walk ranks (discover-by-shapes,
// recommend) carry only ids and shapes, so the step resolver is first visible when the picked template is fetched,
// and that fetch (index.ts, the walk's execute step) is where this check runs: before runTemplate, for every pick
// source (Thompson, reuse, backward chain, bridge, composite).
//
// WHAT COUNTS AS SERVED is what the executor can run (ias-executor-ts engine.ts): a locally registered resolver, a
// template id (activities as resolvers: run as a composed child), or compose / compose_parallel (the children run).
// One addition: a resolver goal-host registered as a cross-vessel proxy counts only while the discovery registry
// still lists its shape, because a proxy registered at boot outlives its vessel's registration. The caller supplies
// that predicate (`served`) from the registry read the walk already makes; this module only walks the template.
// A task's config.pointer.type is not judged: an impulse-resolve task goes to activity-api, which serves shapes
// discovery does not list.
//
// FAIL OPEN, VISIBLY: when the registry could not be read the caller does not judge (it says so in the walk log);
// a composed child that cannot be fetched is not judged here (the executor reports it).

export const UNREGISTERED_STEP_RESOLVER = "unregistered_step_resolver";

/** The shaped reason recorded for a pick refused here. */
export function unregisteredStepReason(resolver: string): string {
  return `${UNREGISTERED_STEP_RESOLVER}:${resolver}`;
}

interface TaskLike {
  resolver?: unknown;
  subActivityId?: unknown;
  subActivityIds?: unknown;
}

function tasksOf(template: unknown): TaskLike[] | null {
  const t = (template ?? null) as { tasks?: unknown } | null;
  return t && Array.isArray(t.tasks) ? (t.tasks as TaskLike[]) : null;
}

/**
 * The first step resolver in `template`, or in a chain it composes (to `depth` levels), that nothing serves; null when
 * every step is served. `served(resolver)` is the registry predicate; `fetchChild(id)` fetches a composed child (or a
 * resolver id that names a template) and returns null when there is none.
 */
export async function firstUnregisteredStep(
  template: unknown,
  served: (resolver: string) => boolean,
  fetchChild: (templateId: string) => Promise<unknown | null>,
  depth = 3,
  seen: Set<string> = new Set(),
): Promise<string | null> {
  const id = (template as { id?: unknown } | null)?.id;
  if (typeof id === "string" && id) seen.add(id);
  const child = async (cid: string): Promise<unknown | null> => {
    if (depth <= 0 || seen.has(cid)) return null;
    seen.add(cid);
    try { return await fetchChild(cid); } catch { return null; }
  };
  for (const task of tasksOf(template) ?? []) {
    const r = typeof task.resolver === "string" ? task.resolver : "";
    if (r === "compose" || r === "compose_parallel") {
      const ids = r === "compose" ? [task.subActivityId] : Array.isArray(task.subActivityIds) ? task.subActivityIds : [];
      for (const cid of ids) {
        if (typeof cid !== "string" || !cid) continue;
        const c = await child(cid);
        const hit = c ? await firstUnregisteredStep(c, served, fetchChild, depth - 1, seen) : null;
        if (hit) return hit;
      }
      continue;
    }
    if (!r || served(r) || seen.has(r)) continue;
    // Activities as resolvers: a resolver id that names a template runs as a composed child, so judge its steps.
    // Past `depth` a template id cannot be told from a missing resolver, so it is not judged.
    if (depth <= 0) continue;
    const c = await child(r);
    if (c && tasksOf(c)) {
      const hit = await firstUnregisteredStep(c, served, fetchChild, depth - 1, seen);
      if (hit) return hit;
      continue;
    }
    return r;
  }
  return null;
}
