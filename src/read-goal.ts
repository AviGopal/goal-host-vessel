/**
 * WHAT A READ GOAL IS, FOR GOAL-TARGET INFERENCE (CHANGE-35 / A2a). A read goal is a question that asks for no change and
 * no durable record: its answer is information, so a mutation-shaped target can never be what it asked for.
 *
 * CLOSED COPY (interim). The reach gate's own question exemptions live in the open rules (src/judge-rules/write-goal.ts),
 * which only src/judge/entries.ts may import; this module restates the same rule from the closed predicates in
 * goal-intent.ts, as src/judge/shapes.ts restates isMutationShape. For a question, the open goalAsksForChange is exactly
 * isEditIntentGoal || goalDemandsLandedEdit || isGapRepairGoal, so only QUESTION_LEAD is copied, and
 * test/judge-rules/read-goal-never-infers-a-write-target.test.ts pins that the two copies agree. The lasting fix is to
 * read the rule through a judge entry (gap filed), so there is one definition again.
 */
import { goalDemandsLandedEdit, goalRequestsDurableArtifact, isEditIntentGoal, isGapRepairGoal } from "./goal-intent";

/** The open rules' QUESTION_LEAD (src/judge-rules/write-goal.ts), copied; the agreement test compares the two. */
export const QUESTION_LEAD = /^\s*(?:what|which|who|whom|whose|why|how|when|where|is|are|was|were|do|does|did|can|could|should|would|will|has|have)\b/i;

/** A QUESTION: it opens with a question word or ends with "?". */
export function isQuestionGoal(goal: string): boolean {
  return !!goal && (QUESTION_LEAD.test(goal) || /\?\s*$/.test(goal.trim()));
}

/** A READ goal: a question that asks for no change and no durable record. "Can you update X to Y?" is not one. */
export function isReadQuestionGoal(goal: string): boolean {
  if (!isQuestionGoal(goal)) return false;
  if (isEditIntentGoal(goal) || goalDemandsLandedEdit(goal) || isGapRepairGoal(goal)) return false;
  return !goalRequestsDurableArtifact(goal);
}
