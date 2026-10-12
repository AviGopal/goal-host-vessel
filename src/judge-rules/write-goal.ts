/**
 * A WRITE OR CHANGE GOAL IS REACHED BY AN ARTIFACT, NEVER BY PROSE.
 *
 * The class this rule exists for: a goal that asks for a change in behaviour, or for a stored record,
 * judged reached on text alone. A floor run with zero tools and zero writes whose answer is a plan; a walk
 * whose only write is a prose note (a concept or memory note) when the goal asked for a mechanism to
 * change. Neither produced the artifact the goal asked for, so neither reached it.
 *
 * These are the deterministic rules (no LLM, no I/O). The closed judge core (src/judge/) calls them at the
 * reach gate, the floor and the floor-reuse shortcut, renders their reason text, and clamps their output.
 *
 * The goal-intent predicates are REUSED, not copied. The added lexical rules, IMPERATIVE_CHANGE_LEAD and
 * IMPERATIVE_WRITE_LEAD, cover what none of them catch: a pathless, code-word-free imperative
 * ("Make the system notice ...", "File a gap ...").
 */
import { goalDemandsLandedEdit, goalRequestsDurableArtifact, isEditIntentGoal, isGapRepairGoal } from "../goal-intent";
import { isStoreWriteShape } from "../resolve-pointer";
import { FS_WRITE_SHAPES } from "../fs-write-shapes";
import type { ReachGateInput } from "../judge/records";
import type { RuleVerdict } from "../judge/classes";

/**
 * A sentence that OPENS with a change verb, as an instruction. Only a sentence-initial verb counts
 * (start of text, after . ! ; : or a newline, optionally after "please"/"now"/"then"/"and"/"so"), so
 * "Explain what makes X slow" and "why does the gate stop it" are not instructions.
 */
export const IMPERATIVE_CHANGE_LEAD =
  /(?:^|[.!;:]\s+|\n\s*)(?:(?:please|now|then|and|so)\s+)*(make|repair|stop|fix|change|add|remove|delete|update|modify|implement|land|patch|teach)\b/i;

/**
 * write / create / file / record lead an instruction to PERSIST only when their direct object is a
 * stored thing ("File a gap", "Write ONE failing test", "create a new resolver"). "Write three
 * interview questions" or "Write a summary of X" asks for text, and the text is the deliverable.
 */
export const IMPERATIVE_WRITE_LEAD =
  /(?:^|[.!;:]\s+|\n\s*)(?:(?:please|now|then|and|so)\s+)*(?:write|create|file|record)\s+(?:(?:a|an|the|one|new|its|their|\d+)\s+)?(?:[a-z-]+\s+){0,2}?(?:gaps?|files?|tests?|entry|entries|records?|rows?|notes?|concepts?|commits?|activity|activities|templates?|variants?|polic(?:y|ies)|labels?|issues?|tickets?|branch|scripts?|modules?|resolvers?|functions?|migrations?)\b/i;

/** A prose destination: the goal is ABOUT a note/vault/concept/memory record, so a prose-sink write
 *  is its artifact (the same nouns goal-intent's durable-artifact rule reads, as a destination). */
const PROSE_DESTINATION_NOUN = /\b(?:notes?|vault|obsidian|concepts?|memo|journal|memory|knowledge|findings?)\b/i;

/** A question is never an instruction to change something, whatever verb it opens a clause with. */
const QUESTION_LEAD = /^\s*(?:what|which|who|whom|whose|why|how|when|where|is|are|was|were|do|does|did|can|could|should|would|will|has|have)\b/i;

/** Shapes whose production IS a mutation: a store write, a filesystem/code write, or an *_update/_create/_delete. */
export function isMutationShape(shape: string): boolean {
  return isStoreWriteShape(shape) || FS_WRITE_SHAPES.has(shape) || /_(?:update|create|delete)$/.test(shape);
}

/**
 * Prose sinks: a write here stores TEXT (a note, a concept). It is the artifact of a goal that asked
 * for a durable record, and never the artifact of a goal that asked for a change in behaviour.
 * The four store-write sinks applied-write.ts names, plus the obsidian surface's note write.
 */
export const PROSE_SINK_SHAPES: ReadonlySet<string> = new Set([
  "concept_write", "concept_create_write", "memoryNote_write", "write_note", "obsidian:write_note",
]);

/**
 * The goal asks for a change in BEHAVIOUR (code, mechanism, the system's own conduct), as opposed to
 * a record of text: the existing edit / landing / gap-repair classes, or a sentence-initial imperative
 * change verb, unless the goal reads as a question.
 */
export function goalAsksForBehaviourChange(goal: string): boolean {
  if (!goal) return false;
  if (isEditIntentGoal(goal) || goalDemandsLandedEdit(goal) || isGapRepairGoal(goal)) return true;
  if (QUESTION_LEAD.test(goal) || /\?\s*$/.test(goal.trim())) return false;
  return IMPERATIVE_CHANGE_LEAD.test(goal);
}

/** The goal asks for a change in behaviour, or opens with an instruction to persist a stored thing. */
export function goalAsksForChange(goal: string): boolean {
  if (goalAsksForBehaviourChange(goal)) return true;
  if (!goal || QUESTION_LEAD.test(goal) || /\?\s*$/.test(goal.trim())) return false;
  return IMPERATIVE_WRITE_LEAD.test(goal);
}

/**
 * Change/write intent: the goal asks for a change, asks for a durable record, or any of its requested
 * target shapes is a mutation shape.
 */
export function goalRequiresArtifact(goal: string, targets: readonly string[] = []): boolean {
  return goalAsksForChange(goal) || goalRequestsDurableArtifact(goal) || targets.some(isMutationShape);
}

export interface WriteArtifactEvidence {
  /** Mutation shapes this execution actually wrote and the vessel accepted (or read back). */
  persistedWrites: readonly string[];
  /** The goal's requested target shapes (deliverables, else inferred targets); empty when unknown. */
  targets?: readonly string[];
  /** An edit-result shape WITH landing evidence (push_status:pushed / new_git_sha) is present. */
  landed?: boolean;
  /** The walk's post-reach bridge writes the note/concept for a durable-record goal after the
   *  verdict, so that goal's sink write cannot exist yet at the gate (walk only). */
  postReachSink?: boolean;
}

/**
 * The persisted writes that count as THIS goal's artifact:
 *   - a mutation shape (isMutationShape);
 *   - related to the goal: one of its requested targets, when targets are known;
 *   - not a prose sink, unless the goal asked for a durable record, names a prose destination
 *     (notes, vault, concept, memory), or asks for no change in behaviour.
 */
export function artifactWrites(goal: string, ev: WriteArtifactEvidence): string[] {
  const targets = new Set(ev.targets ?? []);
  const proseIsTheArtifact = goalRequestsDurableArtifact(goal) || PROSE_DESTINATION_NOUN.test(goal) || !goalAsksForBehaviourChange(goal);
  return [...new Set(ev.persistedWrites)].filter((w) => {
    if (!isMutationShape(w)) return false;
    if (targets.size > 0 && !targets.has(w)) return false;
    if (PROSE_SINK_SHAPES.has(w) && !proseIsTheArtifact) return false;
    return true;
  });
}

export type WriteGoalGate = { hollow: false } | { hollow: true; change: boolean };

/**
 * A goal with change/write intent is reached ONLY by a landed sha or a persisted write that counts as
 * its artifact (artifactWrites). Plan or prose text alone is hollow. Applied at the reach gate AFTER the
 * deterministic oracles that verify an artifact themselves (favorable compose landed, the
 * compute-artifact note read-back) and BEFORE the citation oracle and the LLM judge, which grade text.
 */
export function writeGoalArtifactGate(goal: string, ev: WriteArtifactEvidence): WriteGoalGate {
  const targets = ev.targets ?? [];
  // A prose-sink target the walk's post-reach bridge writes AFTER the verdict (an obsidian note for a
  // vault question, a goal_finding concept) is delivery, not the goal's ask: it does not make a
  // question a write goal.
  const intentTargets = ev.postReachSink ? targets.filter((t) => !PROSE_SINK_SHAPES.has(t)) : targets;
  if (!goalRequiresArtifact(goal, intentTargets)) return { hollow: false };
  if (ev.landed) return { hollow: false };
  if (ev.postReachSink && goalRequestsDurableArtifact(goal) && !goalAsksForBehaviourChange(goal)) return { hollow: false };
  if (artifactWrites(goal, ev).length > 0) return { hollow: false };
  return { hollow: true, change: goalAsksForBehaviourChange(goal) };
}

/**
 * The reach-gate decision on a judge-input record. `reached: true` means THIS rule does not hollow the
 * verdict (the later layers decide); `reached: false` is a hollow the core returns as the verdict.
 * The gate classifies on the targets the judge site resolved (`targets_seen_by_walk`).
 */
export function reachGate(input: ReachGateInput): RuleVerdict {
  const g = writeGoalArtifactGate(input.goal, {
    persistedWrites: input.evidence.persisted_writes,
    targets: input.targets_seen_by_walk,
    landed: input.evidence.landed,
    postReachSink: input.evidence.post_reach_sink,
  });
  if (!g.hollow) return { reached: true, hollow_class: null, reason_code: "write-goal-gate:pass", deterministic: false };
  return { reached: false, hollow_class: "write-goal-no-artifact", reason_code: g.change ? "write-goal-no-artifact:change" : "write-goal-no-artifact:write", deterministic: false };
}
