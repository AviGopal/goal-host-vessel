/**
 * Is a recorded pathway step a `satisfier:<shape>` pseudo-id rather than a real
 * activity template id?
 *
 * WHY THIS EXISTS. `recommendReachingPath` returns a proven pathway and the
 * recovery loop seeds the walk on its HEAD by passing that id as
 * `targetTemplateId`. But a pathway step is not always a template: roughly 40%
 * of all recorded path steps are `satisfier:<shape>` pseudo-ids, and 63.5% of
 * accepted pathways are satisfier-ONLY. A template listing contains zero
 * `satisfier:*` rows.
 *
 * Pinning one is fatal, not merely wasteful. `GoalHost.runGoal` resolves a
 * pinned target through `getTemplate`, which 404s; and a CALLER-PINNED target
 * deliberately refuses to fall through to the next ranked candidate, because
 * silently running something other than what was asked for is worse than
 * failing. So the dispatch dies with
 * `template 'satisfier:fs_edit' not found in shared catalogue or activity-api`
 * before a single walk step executes — observed killing an edit-intent goal
 * whose target shape had been inferred CORRECTLY.
 *
 * The fix is to decline to PIN such a head, not to discard the pathway: the
 * walk's satisfier plane serves these shapes directly ("VESSEL-RESOLVE
 * SATISFIER produced <shape> directly — no bridge needed"), so an unpinned
 * dispatch falls through to ordinary shape-directed selection and runs.
 *
 * Extracted into its own module so it can be tested at all — importing
 * `index.ts` boots an HTTP server, and testing a COPY of the predicate is the
 * self-confirming trap.
 */

/** The prefix the walk uses to denote a satisfier pseudo-activity. */
export const SATISFIER_PREFIX = "satisfier:";

/**
 * True when `id` names a satisfier pseudo-activity rather than a catalogue
 * template.
 *
 * Deliberately strict about the prefix. A template legitimately *named*
 * something like `satisfier-audit` is a real row and must stay pinnable, so the
 * separator is required; matching a bare "satisfier" substring would strip real
 * templates out of the reuse path and quietly disable pathway reuse.
 */
export function isSatisfierPseudoId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(SATISFIER_PREFIX);
}

/**
 * The pathway head to pin as `targetTemplateId`, or `undefined` when the head
 * is a pseudo-id and the caller should defer to shape-directed selection.
 *
 * Returns only the HEAD or nothing — never a later step. The walk seeds on the
 * head, so skipping ahead to the first "real" activity would silently start a
 * different composition than the one the pathway proved.
 */
export function pinnableHead(activities: readonly unknown[] | null | undefined): string | undefined {
  if (!Array.isArray(activities) || activities.length === 0) return undefined;
  const head = activities[0];
  if (typeof head !== "string" || head.length === 0) return undefined;
  return isSatisfierPseudoId(head) ? undefined : head;
}
