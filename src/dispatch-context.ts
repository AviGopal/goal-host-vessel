// THE DISPATCH CONTEXT'S ENTRY RULE. index.ts keeps one AsyncLocalStorage store per dispatch (dispatchContext) and
// enters it at four sites: the /run-goal background run, its cost re-entry, runGoalWithRecovery's admission, and the
// floor's re-entry when its async chain arrives with an empty or foreign store. Every entry builds its store here, so no
// site drops or downgrades a field another site set:
//   - the existing store is kept, and a site sets only the fields it has a value for (an undefined never erases one);
//   - learningMode is sticky once "observe": nothing entered below an observe dispatch runs as learn (observe-mode.ts);
//   - decomposeGapId is set only when absent: a nested value never replaces the field the reach gate grades.

export type DispatchLearningMode = "observe" | "learn";
export interface DispatchContextStore {
  dispatchId: string;
  decomposeGapId?: string;
  learningMode?: DispatchLearningMode;
  /** the dispatch's own goal, for the content check (failure-recall.ts) */
  goal?: string;
}

/** The store an entry site enters: `prev` (the current store, if any) with this site's defined fields laid over it. */
export function enterDispatchContext(prev: DispatchContextStore | undefined, own: { dispatchId: string; decomposeGapId?: string; learningMode?: DispatchLearningMode; goal?: string }): DispatchContextStore {
  const next: DispatchContextStore = { ...prev, dispatchId: own.dispatchId };
  if (own.decomposeGapId && !next.decomposeGapId) next.decomposeGapId = own.decomposeGapId;
  if (own.learningMode && next.learningMode !== "observe") next.learningMode = own.learningMode;
  if (own.goal) next.goal = own.goal;
  return next;
}
