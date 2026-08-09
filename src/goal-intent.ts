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
/**
 * A "durable artifact" is a permanent record the substrate should write, typically
 * to disk or a knowledge base, based on a goal requesting a record/save verb plus
 * a durable noun. It signifies an intent to persist information beyond the current
 * execution context.
 *
 * This is the condition the terminal-output bridge already used to decide whether to
 * materialize a walk's content into a sink. It is shared because the floor cannot deliver
 * artifacts: the floor's reach returns above the bridge, so a shortcut that skips the walk
 * for an artifact-requesting goal reaches, grades itself honestly, and writes nothing.
 * Observed live (dispatch cb45905c): floor reused, reached with 6/7 tools, verdict
 * delivered — and the note the goal named was never created at all.
 */
export function goalRequestsDurableArtifact(goal: string): boolean {
  // `writ` was in this list as a bare alternative inside \b(...)\b, which requires a word
  // boundary right after the T — so it matched only the standalone noun "writ" and never
  // "write", "writes", "writing" or "written". The most natural phrasing for asking for a
  // durable artifact, "write a note titled X", did not register as one. Found by a test
  // asserting the stem worked; it did not.
  const verb = /\b(record|save|persist|document|capture|writ(?:e|es|ing|ten)?|note down|log|jot|archive)\b/i.test(goal);
  const noun = /\b(notes?|findings?|vault|obsidian|concepts?|report|document|memo|knowledge|journal)\b/i.test(goal);
  return verb && noun;
}

export function isEditIntentGoal(goal: string): boolean {
  return (
    // /repos/[\w.-]+/[\w.\/-]+\.\w+/.test(goal) &&
    /\b(edit|add|insert|append|prepend|change|modify|replace|fix|remove|delete|update|rename|refactor|wire|guard)\b/i.test(goal)
  );
}
