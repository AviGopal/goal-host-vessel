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
 *   - change is FORBIDDEN outright: prohibitsAnyMutation, or a no-change instruction on everything the goal could
 *     change ("without touching anything", "leave the file untouched", "everything stays unchanged", or the goal's
 *     ONLY named file), or read-only as the request's MODE ("Read-only pass: ...");
 *   - NO clause opens with an instruction to change (an imperative edit verb, or "can/could you <edit verb>").
 * A qualifier on a PARTICULAR object scopes an edit, it does not prohibit one: "without changing its signature",
 * "so existing callers stay unchanged", "keeping the API unchanged", "without altering its return type", "without
 * changing anything else", "without touching any test files", "without changing the file layout", "without changing
 * <another file>", "make the field read-only". Measured on this predicate's earlier forms (any "without <change>" or
 * "un<change>ed"; then an object that let an adjective in, a noun after, or a different file stand for everything):
 * each of those real edits walked, or lost its landed-edit demand and so could reach on prose with no edit.
 */
const CLAUSE_JOINER = String.raw`(?:and|then|just|please|only|now|so)`;
const CLAUSE_LEAD = String.raw`(?:^|[.!?;:,]\s*|\n\s*|\b${CLAUSE_JOINER}\s+|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?)`;
// A clause ends here: punctuation, the end, or a clause joiner.
const CLAUSE_END = String.raw`(?=\s*(?:[.!?;:,]|$)|\s+${CLAUSE_JOINER}\b)`;
const DESCRIPTION_REQUEST = new RegExp(String.raw`${CLAUSE_LEAD}(?:tell me|describe|explain|report|summari[sz]e|outline|list|show me)\b`, "i");
const QUESTION = /^\s*(?:what|which|who|whose|why|how|when|where|is|are|does|do|did|can|could|would|should|will)\b|\?\s*$/i;
const CHANGE_STEM = String.raw`(?:edit|add|insert|append|prepend|chang|modif|replac|fix|remov|delet|updat|renam|refactor|wir|guard|creat|regist|scaffold|touch|alter|writ)`;
// The whole of what the goal could change, never a part of it: no word inside it ("any test files"), nothing that
// excludes ("anything else", "any other file", "the file's API"). Whatever follows it ("anything yet", "the code at
// all", "the source in any way", "the file or its tests") does not narrow it, with one exception below.
const NOT_A_PART = String.raw`(?!['\w-]|\s+(?:else|other|outside|beyond|besides|except|but)\b)`;
const WHOLE = String.raw`(?:anything|everything|any\s+files?|files)${NOT_A_PART}`;
const THE_WHOLE = String.raw`(?:the|this|that)\s+(?:file|files|source|code|codebase|repo|repository|tree|working tree)${NOT_A_PART}`;
// One exception, and only inside a clause (a "without" clause that does not open its clause qualifies the change
// requested before it): "the file"/"the code" followed by exactly ONE word that closes the clause is a compound naming
// a part ("<edit> without changing the file layout;"), a scope. A "without" clause that OPENS its clause ("Without
// touching the code yet, explain ...") is always the whole. Without a lexicon one word cannot be told from an adverb,
// so mid-clause "... without touching the code yet." still reads as a compound (stated debt).
const COMPOUND = String.raw`(?!\s+[a-z]+${CLAUSE_END})`;
const UNIVERSAL = String.raw`(?:${WHOLE}|${THE_WHOLE})`;
const UNIVERSAL_AFTER_WITHOUT = String.raw`(?:${WHOLE}|${THE_WHOLE}${COMPOUND})`;
const FILE_PATH = String.raw`repos\/[\w.\/-]+\.\w+`;
const UNCHANGED = String.raw`(?:un${CHANGE_STEM}\w*ed|as[- ]is|alone|intact)`;
/** The no-change forms: "without <change> obj" (opening its clause, or inside it), "leave obj unchanged", "obj
 *  stays / is left unchanged". */
const noChangeOn = (obj: string, objAfterWithout: string): string =>
  String.raw`${CLAUSE_LEAD}without\s+${CHANGE_STEM}\w*\s+(?:(?:to|in|on)\s+)?${obj}` +
  String.raw`|\bwithout\s+${CHANGE_STEM}\w*\s+(?:(?:to|in|on)\s+)?${objAfterWithout}` +
  String.raw`|\b(?:leave|leaving|keep|keeping)\s+${obj}\s+${UNCHANGED}\b` +
  String.raw`|\b${obj}\s+(?:(?:must|should|will)\s+)?(?:(?:stays?|remains?|is|are|be|left|kept)\s+){0,2}un${CHANGE_STEM}\w*ed\b`;
const CHANGE_PROHIBITION = new RegExp(
  noChangeOn(UNIVERSAL, UNIVERSAL_AFTER_WITHOUT) +
    String.raw`|${CLAUSE_LEAD}read-?only\s*(?:[:;,.!-]|$|(?:please|pass|mode|request|question|task|review|analysis|investigation)\b)` +
    String.raw`|\b(?:stay|stays|remain|remains)\s+read-?only\b|\bthis is a read-?only\b`,
  "i",
);
// A named file is everything the goal could change only when it is the ONLY file the goal names.
const NO_CHANGE_ON_FILE = new RegExp(noChangeOn(`(${FILE_PATH})`, `(${FILE_PATH})(?!['\\w-])`), "gi");
const CHANGE_INSTRUCTION = new RegExp(String.raw`${CLAUSE_LEAD}(?:${CHANGE_STEM}|implement|extend)\w*\b`, "i");

function forbidsChangeToItsOnlyFile(goal: string): boolean {
  const named = new Set(goal.match(new RegExp(FILE_PATH, "g")) ?? []);
  if (named.size !== 1) return false;
  for (const m of goal.matchAll(NO_CHANGE_ON_FILE)) if (named.has(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "")) return true;
  return false;
}

export function asksForDescriptionUnderChangeProhibition(rawGoal: string): boolean {
  const goal = canonicalGoalText(rawGoal);
  const asksForDescription = DESCRIPTION_REQUEST.test(goal) || QUESTION.test(goal);
  const forbidsChange = prohibitsAnyMutation(goal) || CHANGE_PROHIBITION.test(goal) || forbidsChangeToItsOnlyFile(goal);
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
