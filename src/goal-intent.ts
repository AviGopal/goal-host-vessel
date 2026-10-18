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
export function goalRequestsDurableArtifact(rawGoal: string): boolean {
  const goal = canonicalGoalText(rawGoal);
  // `writ` was in this list as a bare alternative inside \b(...)\b, which requires a word
  // boundary right after the T — so it matched only the standalone noun "writ" and never
  // "write", "writes", "writing" or "written". The most natural phrasing for asking for a
  // durable artifact, "write a note titled X", did not register as one. Found by a test
  // asserting the stem worked; it did not.
  const verb = /\b(record|save|persist|document|capture|writ(?:e|es|ing|ten)?|note down|log|jot|archive)\b/i.test(goal);
  const noun = /\b(notes?|findings?|vault|obsidian|concepts?|report|document|memo|knowledge|journal)\b/i.test(goal);
  return verb && noun;
}

/**
 * THE ONE GOAL-TEXT CANONICALIZATION (user ruling 2026-10-17T00:00:17Z "Include canonicalization"). Every goal-text
 * predicate reads the goal through this, and /run-goal applies it once at ingress, so a predicate's wording can never be
 * defeated by typography: "don’t" (U+2019) did not match prohibitsAnyMutation's "don't", and an edit-intent goal
 * typed with smart quotes routed differently from the same goal typed plainly. NFKC folds compatibility forms
 * (full-width letters, ligatures, non-breaking spaces); the quote map folds the typographic quotes NFKC leaves alone.
 * Idempotent: canonicalGoalText(canonicalGoalText(g)) === canonicalGoalText(g).
 */
export function canonicalGoalText(goal: string): string {
  return goal.normalize("NFKC").replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
}

/** A goal that forbids every change ("Do not change anything", "don't edit or update any file", ...). Exported so the
 *  routing hand-off reads the SAME predicate as isEditIntentGoal (a-negated-edit-instruction-is-routed-to-a-landing-compose). */
export function prohibitsAnyMutation(rawGoal: string): boolean {
  const goal = canonicalGoalText(rawGoal);
  const negatedVerbClause = /\b(?:do not|don't|never|please do not|you must not|do NOT)\b\s+(?:just\s+)?(?:change|edit|modify|update|delete|rename|refactor|fix|touch|add|remove|write(?:\s+to)?|create|implement|extend|apply(?:\s+edits\s+to)?)[\s\S]{0,80}\b(?:anything|any file|the source|a single line of it|the file)\b/i;
  const withoutGerund = /\bwithout\s+(?:writing|creating|generating|authoring|scaffolding)\b[\s\S]{0,80}\b(?:anything|any file|files?)\b/i;
  const readOnlyNo = /\bread-?only\b[\s\S]{0,80}\bno\s+(?:writing|creating|scaffolding)\b/i;
  return negatedVerbClause.test(goal) || withoutGerund.test(goal) || readOnlyNo.test(goal);
}

/**
 * A goal that ASKS FOR A DESCRIPTION and FORBIDS CHANGE is not an edit, whatever change verb its description names
 * (a-goal-not-admitted-as-a-change-still-runs-non-filesystem-write-shapes-inside-composed-templates, user ruling "Keep
 * wording-based routing"). Measured: "Leave the file untouched and tell me what would change in <file> ..." went to
 * feature_compose and drafted a real edit; its only change verb sat inside the description it asked for. Three parts,
 * all required, so a real edit that also asks for a report ("Fix X without changing its API, then report") still composes:
 *   - the REQUEST is a description: a clause opens with a describe/explain/tell/report verb, or the goal is a question;
 *   - change is FORBIDDEN in some form: prohibitsAnyMutation, a change negated by "without", an un-prefixed change
 *     participle, or a read-only marker (negation applied to change, not a list of sentences);
 *   - NO clause opens with an instruction to change (an imperative edit verb).
 */
const CLAUSE_LEAD = String.raw`(?:^|[.!?;:,]\s*|\n\s*|\b(?:and|then|just|please|only|now|so)\s+)`;
const DESCRIPTION_REQUEST = new RegExp(String.raw`${CLAUSE_LEAD}(?:tell me|describe|explain|report|summari[sz]e|outline|list|show me)\b`, "i");
const QUESTION = /^\s*(?:what|which|who|whose|why|how|when|where|is|are|does|do|did|can|could|would|should|will)\b|\?\s*$/i;
const CHANGE_STEM = String.raw`(?:edit|add|insert|append|prepend|chang|modif|replac|fix|remov|delet|updat|renam|refactor|wir|guard|creat|regist|scaffold|touch|alter|writ)`;
const NEGATED_CHANGE = new RegExp(String.raw`\bwithout\s+${CHANGE_STEM}\w*|\bun${CHANGE_STEM}\w*ed\b|\bread-?only\b`, "i");
const CHANGE_INSTRUCTION = new RegExp(String.raw`${CLAUSE_LEAD}${CHANGE_STEM}\w*\b`, "i");

export function asksForDescriptionUnderChangeProhibition(rawGoal: string): boolean {
  const goal = canonicalGoalText(rawGoal);
  const asksForDescription = DESCRIPTION_REQUEST.test(goal) || QUESTION.test(goal);
  const forbidsChange = prohibitsAnyMutation(goal) || NEGATED_CHANGE.test(goal);
  return asksForDescription && forbidsChange && !CHANGE_INSTRUCTION.test(goal);
}

export function isEditIntentGoal(rawGoal: string): boolean {
  const goal = canonicalGoalText(rawGoal);
  return (
    /repos\/[\w.-]+\/[\w.\/-]+\.\w+/.test(goal) &&
    /\b(edit|add|insert|append|prepend|change|modify|replace|fix|remove|delete|update|rename|refactor|wire|guard|compose|create|creates|creating|author|authors|authoring|write|writes|writing|scaffold|scaffolds|scaffolding|generate|generates|generating)\b/i.test(goal) && !prohibitsAnyMutation(goal) &&
    !asksForDescriptionUnderChangeProhibition(goal)
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
export function goalDemandsLandedEdit(rawGoal: string | undefined): boolean {
  if (!rawGoal) return false;
  const goal = canonicalGoalText(rawGoal);
  const asksForCodeChange =
    /repos\/[\w.-]+\/[\w./-]+\.\w+/.test(goal) || isPathlessCodeChangeGoal(goal);
  if (!asksForCodeChange) return false;
  if (prohibitsAnyMutation(goal) || asksForDescriptionUnderChangeProhibition(goal)) return false;
  const mutationVerb =
    /\b(edit|add|insert|change|modify|replace|fix|update|refactor|implement|extend|apply|wire|guard|remove|widen|broaden|loosen|relax|tighten|narrow|close)\b/i.test(goal);
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

/**
 * The gap-lifecycle loop's own standing repair-attempt phrasing: "Close substrate gap
 * <id>: <description>" (distinct from "investigate and decompose gap <id>", which asks
 * only for a diagnosis). This is a CODE-CHANGE ask by construction — the gap-lifecycle
 * loop only dispatches it to actually close something — but `isPathlessCodeChangeGoal`'s
 * MUTATION_VERB list does not contain "close", "author", or "resolve" (the verbs this
 * exact phrasing and its own gap descriptions use, e.g. "...author an improvement so it
 * reaches"), so `goalDemandsLandedEdit` returned false for it and the landing-evidence
 * gate below never applied.
 *
 * Observed live 2026-08-28 (goal_hash=8b3afc7c, then reproduced on goal_hash=16cb4a28 —
 * a repair attempt on the very gap filed to describe this defect): the walk genuinely
 * tried to compose a fix, failed (feature_compose timeout / no producer for
 * code_modification_proposal), and rather than reaching false, the floor's LLM judge
 * passed a bare narration ("Implemented a targeted fix...") with zero fs_edit and zero
 * goal_verification_label. A false "fixed" claim is worse than an honest failure: it can
 * be read back as evidence in a later gap-hydration cycle. This predicate is additive
 * only — it widens the REACH-VERDICT gate, not routing, so a genuine future close-gap
 * dispatch that DOES land a real commit is unaffected; only narration-only false
 * positives on this exact phrasing are newly caught.
 */
export function isGapRepairGoal(rawGoal: string | undefined): boolean {
  const goal = rawGoal ? canonicalGoalText(rawGoal) : rawGoal;
  return !!goal && /\bclose\b[^.]{0,30}\b(substrate\s+)?gap\b/i.test(goal);
}
