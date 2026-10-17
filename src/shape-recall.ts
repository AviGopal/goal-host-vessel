/**
 * TARGET CANDIDATES ARE RECALLED BY MEANING (I-T structural, piece (3); user statement 2026-10-17T01:11:12Z).
 *
 * Goal-target inference used to be shown every advertised shape NAME (and the first fix, every DESCRIPTION): O(shapes)
 * per call, which fails by design as the registry grows. The candidate set is now BOUNDED by k, independent of the
 * shape count:
 *   - RECALL: the top-k shapes whose descriptions match the goal's meaning, from concept-db's shape index (its existing
 *     search, the shared scope as written by the system org);
 *   - UNION the target shapes of this goal class's recorded paths (the learned prior, step 8e), so a pathway that reached
 *     stays a candidate even when its wording recalls something else;
 *   - COLD START: recall is a pure-similarity arm, never gated by posteriors, so a shape added an hour ago is a candidate
 *     for a goal that means it; selection then meets it at the uninformed Beta(1,1) prior like any arm.
 * k is a shaped value read at use time (the caller's shapedBudget). When recall cannot be asked (concept-db down, empty
 * index), the decision runs on the NAMED DEGRADED tier (today's names-only path) and records that it did.
 */
import type { CatalogEntry, ShapeCatalog } from "./described-producers";

export interface RecalledRow { content?: string; summary?: string; pointer?: { name?: unknown } | null }
export type RecallTier = "recall" | "degraded";

export interface RecalledCandidates {
  tier: RecallTier;
  /** why the degraded tier ran (null on recall) */
  reason: string | null;
  /** the bounded candidate catalog (recalled ∪ goal-path), restricted to advertised shapes */
  catalog: ShapeCatalog;
  /** the candidate shape names, in recall order then goal-path order */
  shapes: string[];
  recalled: string[];
  fromGoalPaths: string[];
}

/** The described entry a recalled row carries: its indexed content is "<name>: <description>". */
function entryOf(row: RecalledRow): { name: string; entry: CatalogEntry } | null {
  const name = typeof row.pointer?.name === "string" ? row.pointer.name : "";
  if (!name) return null;
  const content = String(row.content ?? "");
  const description = content.startsWith(`${name}: `) ? content.slice(name.length + 2) : content;
  return description.trim() ? { name, entry: { description: description.trim() } } : null;
}

/**
 * The bounded candidates for a goal. `rows` is the recall answer (null = recall could not be asked), `goalPathShapes` the
 * learned prior's target shapes, `known` the advertised vocabulary (a candidate must still be advertised).
 */
export function recalledCandidates(rows: RecalledRow[] | null, goalPathShapes: readonly string[], known: ReadonlySet<string>): RecalledCandidates {
  if (rows === null) return { tier: "degraded", reason: "shape recall could not be asked (concept-db unreachable or refused)", catalog: {}, shapes: [], recalled: [], fromGoalPaths: [] };
  const catalog: ShapeCatalog = {};
  const recalled: string[] = [];
  for (const r of rows) {
    const e = entryOf(r);
    if (!e || !known.has(e.name) || catalog[e.name]) continue;
    catalog[e.name] = e.entry;
    recalled.push(e.name);
  }
  if (recalled.length === 0) return { tier: "degraded", reason: rows.length === 0 ? "the shape index returned no candidates for this goal" : "no recalled shape is advertised here", catalog: {}, shapes: [], recalled: [], fromGoalPaths: [] };
  const fromGoalPaths = goalPathShapes.filter((s) => known.has(s) && !catalog[s]);
  // a goal-path shape the index did not recall still enters, described by name only (its recorded reach is the evidence)
  for (const s of fromGoalPaths) catalog[s] = { description: `(a target this goal class reached before) ${s}` };
  return { tier: "recall", reason: null, catalog, shapes: [...recalled, ...fromGoalPaths], recalled, fromGoalPaths };
}
