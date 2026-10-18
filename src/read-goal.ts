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

/** The open rules' IMPERATIVE_CHANGE_LEAD and IMPERATIVE_WRITE_LEAD (src/judge-rules/write-goal.ts), copied; the agreement
 *  test compares them. */
export const IMPERATIVE_CHANGE_LEAD =
  /(?:^|[.!;:]\s+|\n\s*)(?:(?:please|now|then|and|so)\s+)*(make|repair|stop|fix|change|add|remove|delete|update|modify|implement|land|patch|teach)\b/i;
export const IMPERATIVE_WRITE_LEAD =
  /(?:^|[.!;:]\s+|\n\s*)(?:(?:please|now|then|and|so)\s+)*(?:write|create|file|record)\s+(?:(?:a|an|the|one|new|its|their|\d+)\s+)?(?:[a-z-]+\s+){0,2}?(?:gaps?|files?|tests?|entry|entries|records?|rows?|notes?|concepts?|commits?|activity|activities|templates?|variants?|polic(?:y|ies)|labels?|issues?|tickets?|branch|scripts?|modules?|resolvers?|functions?|migrations?)\b/i;

/**
 * THE GOAL'S OWN WORDS DEMAND AN ARTIFACT: the open goalAsksForChange(goal) || goalRequestsDurableArtifact(goal) (the reach
 * gate's goalRequiresArtifact with no targets), restated from the closed predicates. For such a goal only a landed sha or a
 * persisted mutation write on one of its targets reaches, so goal-target inference must never take its mutation targets
 * away (a retry that drops them is structurally unreachable). Pinned equal to the open rule by the agreement test.
 */
export function goalDemandsArtifact(goal: string): boolean {
  if (!goal) return false;
  if (isEditIntentGoal(goal) || goalDemandsLandedEdit(goal) || isGapRepairGoal(goal) || goalRequestsDurableArtifact(goal)) return true;
  if (isQuestionGoal(goal)) return false;
  return IMPERATIVE_CHANGE_LEAD.test(goal) || IMPERATIVE_WRITE_LEAD.test(goal);
}
