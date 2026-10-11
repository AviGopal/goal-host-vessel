/**
 * A WRITE OR CHANGE GOAL IS REACHED BY AN ARTIFACT, NEVER BY PROSE.
 *
 * Measured on node 1 over ~5 days: the floor (universal-tool-fallback) recorded 36 reached=true runs,
 * and 0 of the 36 produced a shape, persisted a write or landed a sha. Every one was a verdict on text
 * (22 LLM-judge prose, 14 a citation check). 17 of them recorded a write/mutation shape as the path's
 * endpoint output, so a later write goal borrowed the floor as a "proven" pathway and skipped its walk.
 * Two live instances:
 *   - N5 (execution universal-tool-fallback-c154c685-1791710679359): tools 0/0, the answer said the
 *     call to substrateGap_write "was successful", targets [substrateGap_write, gap_lifecycle_scan],
 *     judged reached; the path was stored with both targets as its endpoint shapes.
 *   - N10 (dispatch 0f03761a): a goal asking for a mechanism change ("make that evidence stop the
 *     system choosing them") judged reached on a prose concept_write plus an unrelated
 *     learningPolicyWriteback; nothing about the selection mechanism changed.
 *
 * This module holds the deterministic rules (no LLM). index.ts boots a server on import, so the
 * rules live here where a unit test can reach them; index.ts applies them at the reach gate, the
 * floor and the floor-reuse shortcut.
 *
 * The goal-intent predicates are REUSED, not copied (goal-intent.ts is not edited here). The added
 * lexical rules, IMPERATIVE_CHANGE_LEAD and IMPERATIVE_WRITE_LEAD, cover what none of them catch: a
 * pathless, code-word-free imperative ("Make the system notice ...", "File a gap ...").
 */
import { goalDemandsLandedEdit, goalRequestsDurableArtifact, isEditIntentGoal, isGapRepairGoal } from "./goal-intent";
import { isStoreWriteShape } from "./resolve-pointer";
import { FS_WRITE_SHAPES } from "./fs-write-shapes";

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

export type WriteGoalGate = { hollow: false } | { hollow: true; reason: string };

/**
 * Item 1: a goal with change/write intent is reached ONLY by a landed sha or a persisted write that
 * counts as its artifact (artifactWrites). Plan or prose text alone is hollow. Applied at the reach
 * gate AFTER the deterministic oracles that verify an artifact themselves (favorable compose landed,
 * the compute-artifact note read-back) and BEFORE the citation oracle and the LLM judge, which grade
 * text.
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
  const wrote = [...new Set(ev.persistedWrites)];
  return {
    hollow: true,
    reason: `deterministic:write-goal-no-artifact — the goal asks for a ${goalAsksForBehaviourChange(goal) ? "change" : "write"}${targets.length ? ` (targets [${targets.slice(0, 4).join(", ")}])` : ""}, and a change/write goal is reached only by a landed sha or a persisted write of its own target; ${wrote.length ? `the writes this run made ([${wrote.slice(0, 4).join(", ")}]) are prose or unrelated to it` : "this run persisted no write and landed nothing"}, so a plan or prose answer cannot reach it`,
  };
}

/**
 * Item 2: the text ASSERTS that a write or a tool/resolver call succeeded (or that a record was
 * created). Paired with an execution that ran zero tools and wrote nothing, the assertion is false by
 * construction. Observed: "it's likely that the actual call to substrateGap_write was successful".
 */
const WRITE_SUCCESS_CLAIMS: readonly RegExp[] = [
  /\b(?:call|calls|write|writes|request|operation|update|insert|tool\s+call)\b[^.\n]{0,80}?\b(?:was|were|is|has\s+been|have\s+been)\s+(?:likely\s+|probably\s+|most\s+likely\s+)?(?:successful|succeeded|completed|created|written|recorded|filed|persisted|applied|saved)\b/i,
  /\b[A-Za-z]\w*_write\b[^.\n]{0,80}?\b(?:succeeded|successful|success|created|written|recorded|filed|persisted|applied|saved)\b/i,
  /\b(?:i|we)\s+(?:have\s+|successfully\s+|have\s+successfully\s+)?(?:created|filed|wrote|written|recorded|persisted|saved|called|invoked|inserted|updated|registered)\s+(?:a|an|the|it|this|that|new)\b/i,
  /\bsuccessfully\s+(?:created|filed|wrote|written|recorded|persisted|saved|called|invoked|inserted|updated|registered)\b/i,
];

/** A claim that denies the effect inside its own span ("write ... nothing was filed") is not a claim. */
const NEGATION = /\b(?:not|no|nothing|never|cannot|can't|couldn't|didn't|unable|failed)\b|n't\b/i;

export function claimsWriteSucceeded(text: string | undefined | null): boolean {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  return WRITE_SUCCESS_CLAIMS.some((re) => {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of t.matchAll(g)) if (!NEGATION.test(m[0])) return true;
    return false;
  });
}

/** Item 2 decision: the claim, with no tool run, no write and no output impulse, is hollow. */
export function zeroToolWriteClaim(texts: ReadonlyArray<string | undefined | null>, run: { toolsTotal: number; writes: number; outputImpulses?: number }): boolean {
  if (run.toolsTotal !== 0 || run.writes !== 0 || (run.outputImpulses ?? 0) !== 0) return false;
  return texts.some((t) => claimsWriteSucceeded(t));
}

/**
 * Item 3: the floor's completion shapes are the shapes it PRODUCED (its successful write calls),
 * never the shapes it was asked for. A judge-named completion shape survives only if produced.
 * With nothing produced, there are none, and recordGoalPath stores none.
 */
export function floorCompletionShapes(judgeNamed: readonly string[] | undefined, produced: readonly string[]): string[] {
  const prod = [...new Set(produced)];
  const named = (judgeNamed ?? []).filter((s) => prod.includes(s));
  return named.length > 0 ? named : prod;
}

/**
 * Item 4: the REUSE-BEFORE-DERIVE floor shortcut. The floor reads and reasons; it cannot land a
 * commit or deliver an artifact, so the shortcut serves question goals only:
 *   - the pathway is exactly the floor;
 *   - not an edit goal, not a durable-record goal, no mutation-shape target (a *_write target is a
 *     durable artifact on this side);
 *   - a BORROWED pathway (matched by shape signature from another goal) is never reused for a
 *     change/write goal; a goal's OWN pathway still serves its read goal.
 */
export interface FloorShortcutInput {
  goal: string;
  activities: readonly string[];
  /** The pathway came from another goal (recommend match_mode shape_signature). */
  borrowed: boolean;
  targets: readonly string[];
  isFloorId: (activityId: string) => boolean;
}
export function floorShortcutAllowed(i: FloorShortcutInput): { allowed: boolean; why: string } {
  if (i.activities.length !== 1 || !i.isFloorId(String(i.activities[0] ?? ""))) return { allowed: false, why: "pathway is not exactly the floor" };
  if (isEditIntentGoal(i.goal)) return { allowed: false, why: "edit goal" };
  if (goalRequestsDurableArtifact(i.goal)) return { allowed: false, why: "durable-artifact goal" };
  const writeTargets = i.targets.filter(isMutationShape);
  if (writeTargets.length > 0) return { allowed: false, why: `mutation target(s) [${writeTargets.join(", ")}] are a durable artifact the floor cannot deliver` };
  if (i.borrowed && goalRequiresArtifact(i.goal, i.targets)) return { allowed: false, why: "borrowed pathway (another goal's shape-signature match) for a change/write goal" };
  return { allowed: true, why: i.borrowed ? "borrowed floor pathway for a read goal" : "this goal's own floor pathway" };
}
