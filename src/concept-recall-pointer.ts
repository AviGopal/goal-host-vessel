/**
 * The pointer a walk's concept recall sends to concept-db (shape `concept`, a search).
 *
 * A recall made inside a dispatch carries that dispatch's execution id, so concept-db can record which concepts this
 * execution recalled and credit them when the execution reaches (KNOWN-WRONG 21: reached walks credited none of the
 * concepts they recalled, because a search named no execution). The id is the one goal-host already sends as
 * `execution_id` on its other dispatch-scoped calls (the floor tool loop, the walk's tools): the dispatch id. A recall
 * with no dispatch context sends the pointer exactly as before, with no execution_id.
 */
export function conceptRecallPointer(
  query: string,
  limit: number,
  filters: { shape?: string; include_global?: boolean },
  executionId: string | null | undefined,
): Record<string, unknown> {
  return { type: "concept", query, limit, ...filters, ...(typeof executionId === "string" && executionId.length > 0 ? { execution_id: executionId } : {}) };
}
