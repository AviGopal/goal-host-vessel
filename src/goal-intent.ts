import { isPathlessCodeChangeGoal } from "./goal-file-resolution";

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
    /repos\/[\w.-]+\/[\w.\/-]+\.\w+/.test(goal) &&
    /\b(edit|add|insert|append|prepend|change|modify|replace|fix|remove|delete|update|rename|refactor|wire|guard|compose)\b/i.test(goal)
  );
}

/**
 * Does this goal ask for a CODE CHANGE, such that a reach verdict requires landing
 * evidence rather than a description of the change?
 *
 * Exported so the rule is directly assertable: `verifyGoalReached` is unexported and
 * makes LLM calls, so the predicate it turns on could not otherwise be tested.
 *
 * Accepts a goal that names a path OR one the door already classified as a pathless
 * code-change request. Before 2026-08-11 only the first counted, which meant a
 * symptom-phrased change request skipped the landing requirement entirely — the
 * requirement was bound to a ROUTE (edit-intent) rather than to the GOAL, so any route
 * that bypassed edit-intent bypassed the guard.
 */
export function goalDemandsLandedEdit(goal: string | undefined): boolean {
  if (!goal) return false;
  const asksForCodeChange =
    /repos\/[\w.-]+\/[\w./-]+\.\w+/.test(goal) || isPathlessCodeChangeGoal(goal);
  if (!asksForCodeChange) return false;
  const mutationVerb =
    /\b(edit|add|insert|change|modify|replace|fix|update|refactor|implement|extend|apply|wire|guard|remove|widen|broaden|loosen|relax|tighten|narrow)\b/i.test(goal);
  if (mutationVerb) return true;
  // A goal that CREATES a new source file also demands landing evidence. The verb list above
  // was mutation-only, so "Create/Author the file repos/…/x.ts" did NOT demand a landed edit
  // and fell through to the LLM judge, which greens it on narrative ("The system successfully
  // created the specified file") while nothing lands. Measured: dispatch 7a8811bb graded
  // reached:true with the file absent from disk and origin — a persisted false reach in the
  // β-pump class, the SAME failure this block's 2026-08-11 widening set out to stop, just via
  // a creation verb the list omitted. EXCLUDES a durable-artifact NOTE write: those have their
  // own sink/delivery path and need not produce a git sha, so demanding one would falsely
  // reject a note that WAS written (a false rejection is worse than the hole it closes).
  const createsCodeFile =
    /\b(create|creates|creating|write|writes|writing|author|authors|authoring|scaffold|scaffolds|scaffolding|generate|generates|generating)\b/i.test(goal);
  return createsCodeFile && !goalRequestsDurableArtifact(goal);
}
