/**
 * Goal-shape predicates shared across the recovery loop.
 *
 * Extracted because they gate DIFFERENT decisions at different points in the same
 * function — edit-intent routing late, and pathway-reuse routing early — and a copy of
 * the regex at the second site is how the two silently drift apart. index.ts boots a
 * server on import, so anything defined there cannot be tested directly.
 */

/**
 * A plain code-change goal: it names a concrete source file under repos/ AND asks for a
 * mutation. These have their own edit path (feature_compose -> patch_with_tools) and must
 * never be diverted to the ReAct floor, which reads and reasons but does not land commits.
 */
export function isEditIntentGoal(goal: string): boolean {
  return (
    /repos\/[\w.-]+\/[\w.\/-]+\.\w+/.test(goal) &&
    /\b(edit|add|insert|append|prepend|change|modify|replace|fix|remove|delete|update|rename|refactor|wire|guard)\b/i.test(goal)
  );
}
