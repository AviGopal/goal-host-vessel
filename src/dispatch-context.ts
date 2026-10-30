// THE DISPATCH CONTEXT'S ENTRY RULE. index.ts keeps one AsyncLocalStorage store per dispatch (dispatchContext) and
// enters it at four sites: the /run-goal background run, its cost re-entry, runGoalWithRecovery's admission, and the
// floor's re-entry when its async chain arrives with an empty or foreign store. Every entry builds its store here, so no
// site drops or downgrades a field another site set:
//   - the existing store is kept, and a site sets only the fields it has a value for (an undefined never erases one);
//   - learningMode is sticky once "observe": nothing entered below an observe dispatch runs as learn (observe-mode.ts);
//   - decomposeGapId is set only when absent: a nested value never replaces the field the reach gate grades;
//   - a FOREIGN store (another dispatch's: its ids do not include this site's dispatchId) lends nothing but observe:
//     its decomposeGapId and its recall record are dropped (a nested dispatch would otherwise grade the parent's gap
//     and credit its recalls to the parent), while observe stays sticky. A dispatch's ids are its root id and the
//     caller-supplied variables.dispatch_id alias (noteDispatchIds), so the cost and recovery re-entries under the alias
//     are the same dispatch, not foreign. A store whose root recorded no ids (none built before this rule) is never
//     judged foreign: the rule acts only where the ids say so.

export type DispatchLearningMode = "observe" | "learn";
export interface DispatchContextStore {
  dispatchId: string;
  decomposeGapId?: string;
  learningMode?: DispatchLearningMode;
  /** the dispatch's own goal, for the content check (failure-recall.ts) */
  goal?: string;
  /** the concept ids this dispatch's recalls returned (noteRecalledConcepts), carried on its reach verdict */
  recalledConceptIds?: Set<string>;
  /** every id this dispatch runs under (its root id and a caller-supplied alias), set at its root (noteDispatchIds) */
  dispatchIds?: ReadonlySet<string>;
}

/** Whether `prev` belongs to a different dispatch than the one entering as `dispatchId`. */
export function isForeignStore(prev: DispatchContextStore | undefined, dispatchId: string): boolean {
  return prev?.dispatchIds !== undefined && !prev.dispatchIds.has(dispatchId);
}

/** The store an entry site enters: `prev` (the current store, if any) with this site's defined fields laid over it. */
export function enterDispatchContext(prev: DispatchContextStore | undefined, own: { dispatchId: string; decomposeGapId?: string; learningMode?: DispatchLearningMode; goal?: string }): DispatchContextStore {
  const next: DispatchContextStore = { ...prev, dispatchId: own.dispatchId };
  if (isForeignStore(prev, own.dispatchId)) { delete next.decomposeGapId; delete next.recalledConceptIds; delete next.dispatchIds; }
  if (own.decomposeGapId && !next.decomposeGapId) next.decomposeGapId = own.decomposeGapId;
  if (own.learningMode && next.learningMode !== "observe") next.learningMode = own.learningMode;
  if (own.goal) next.goal = own.goal;
  return next;
}

// THE DISPATCH'S RECALL RECORD. concept-db keys a recall by the DISPATCH id the search named (concept-recall-pointer.ts),
// while the reach verdict names the TRACE id, so the two never met and no recalled concept was credited. The verdict
// now names the concepts itself (reachVerdictBody `recalled_concept_ids`), read from ONE record per dispatch: begun
// empty at the dispatch's root entry (the /run-goal run, so an in-process dispatch started inside another never shares
// its parent's record), and shared by reference with every entry below it, since enterDispatchContext's spread keeps
// it. Kept per store, not per id: the cost and recovery re-entries run under variables.dispatch_id, which may differ
// from the root's id within one dispatch. A store with no record (no root entry above it) notes nothing.

/** At most this many recalled concept ids are kept per dispatch, and sent on its reach verdict. */
export const RECALLED_CONCEPT_IDS_CAP = 50;

/** The dispatch's root entry begins its recall record, empty, on the store it just entered. */
export function beginRecallRecord(store: DispatchContextStore | undefined): void {
  if (store) store.recalledConceptIds = new Set<string>();
}

/** The dispatch's root records the ids it runs under: its own and, when the caller supplied one, variables.dispatch_id. */
export function noteDispatchIds(store: DispatchContextStore | undefined, alias: unknown): void {
  if (!store) return;
  store.dispatchIds = new Set([store.dispatchId, ...(typeof alias === "string" && alias.length > 0 ? [alias] : [])]);
}

/** A recall inside a dispatch notes the concept ids it returned (the raw id; concept-db canonicalises it), capped. */
export function noteRecalledConcepts(store: DispatchContextStore | undefined, rows: ReadonlyArray<unknown> | null | undefined): void {
  const ids = store?.recalledConceptIds;
  if (!ids || !Array.isArray(rows)) return;
  for (const r of rows) {
    if (ids.size >= RECALLED_CONCEPT_IDS_CAP) return;
    const id = r && typeof r === "object" ? (r as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
}
