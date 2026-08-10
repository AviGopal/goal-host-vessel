// Extracted from index.ts so it can be TESTED: importing index.ts boots a server
// and throws on a missing LLM_VESSEL_ENDPOINT, so anything defined there is
// unreachable from a unit test. Same reason resolve-file-path.ts and
// goal-file-resolution.ts live outside it — and testing a re-declared COPY is
// the self-confirming-oracle failure this session already found twice.

/**
 * Is this impulse content ONLY execution bookkeeping?
 *
 * Task #59, 2026-08-10. The reach digest is built from any impulse whose content
 * is non-null, then handed to the gate as evidence the goal was answered. A stub
 * carrying nothing but `{producedBy, executionId}` serialises to a plausible
 * string and counts — so a report goal is graded REACHED on a receipt for work
 * that produced no report.
 *
 * This tests for the ABSENCE of substance, not the presence of known-bad keys: a
 * whitelist of "bookkeeping" names would be defeated by the next field someone
 * adds. An object whose every key is provenance metadata has no payload, however
 * many such keys it carries.
 *
 * Deliberately narrow. Only objects are judged; a string, a number or an array
 * is content by construction and is left alone. An object with even ONE
 * non-bookkeeping key passes, because partial content is still content and the
 * substance gate downstream is what judges quality.
 */
export function isBookkeepingOnly(content: unknown): boolean {
  if (typeof content !== "object" || content === null || Array.isArray(content)) return false;
  const keys = Object.keys(content as Record<string, unknown>);
  if (keys.length === 0) return true; // {} carries nothing at all
  const BOOKKEEPING = new Set([
    "producedBy", "produced_by", "executionId", "execution_id", "traceId", "trace_id",
    "activityId", "activity_id", "templateId", "template_id", "dispatchId", "dispatch_id",
    "timestamp", "created_at", "createdAt", "shape", "type", "id", "version",
  ]);
  return keys.every((k) => BOOKKEEPING.has(k));
}
