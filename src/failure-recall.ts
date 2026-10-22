// WHICH EARLIER FAILURE IS A LESSON FOR THIS GOAL, AND HOW IT IS SHOWN (the failure memory's recall side, index.ts).
//
// The near-miss key used to be the goal's first word plus the next token: every "What is …" goal shared the class
// "what". A content-poor goal ("What is this about? dispatch id: <uuid>") was handed a deterministic lesson from "What
// is the weather like in Spain?", labelled only "(a similar goal)", and the writer adopted the OTHER goal's subject:
// it searched the Spain question and was judged as it. Prose tokens say what a goal sounds like, not what work it is.
//
// The key is now the goal-target-inference DECISION (the target set the chooser picked for the goal): two goals that
// infer the same set are asking for the same work whatever their wording. A set made only of writer, evidence, shell
// and seed shapes says "both are questions", not "same work", so it keys nothing. A recalled line names the other
// goal's text and says it is a DIFFERENT goal, so the reader takes the defect, never the subject. Dispatch ids and
// other volatile ids are stripped from goal text before it is shown, recalled on, or checked for content.
import { ANSWER_SHAPES, EVIDENCE_SHAPES } from "./reach-date";

/** Dispatch-id phrases, uuids, and volatile ids (activity-api normalizeGoal's rule: a hex run of >= 8 with a digit,
 *  a 10+ digit number) removed from goal text. Ordinary words, including all-letter hex words, are untouched. */
export function stripDispatchIds(text: string): string {
  return String(text ?? "")
    .replace(/\b(?:dispatch|execution)[ _-]?id\b\s*[:=#]?\s*[0-9a-f][0-9a-f-]{7,}[^\s]*/gi, " ")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ")
    .replace(/\b[0-9a-f]{8,}\b/gi, (m) => (/\d/.test(m) ? " " : m))
    .replace(/\b\d{10,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shapes every kind of goal can target: a target set made only of these does not say which work a goal is. */
const NON_DISCRIMINATING_TARGETS: ReadonlySet<string> = new Set([
  ...ANSWER_SHAPES, ...EVIDENCE_SHAPES, "llm_completion_dispatch", "web_search_result",
  "shellResult", "shell", "bash", "bounded_shell", "goal", "dispatch_id", "universal_fallback_result",
]);

/** The similarity key of a goal-target-inference decision: its sorted target set, or "" when it keys nothing. */
export function targetSimilarityKey(targets: readonly string[] | null | undefined): string {
  const s = [...new Set((targets ?? []).filter((t) => typeof t === "string" && t.length > 0))].sort();
  if (s.length === 0 || s.every((t) => NON_DISCRIMINATING_TARGETS.has(t))) return "";
  return s.join("+");
}

export interface RecallRecord { hash: string; at: string; reason: string; pick: string | null; deterministic: boolean; goal?: string; inferred?: string[] }

/** Other goals' failures since each one's last reach whose recorded inference decision has this goal's key, newest first. */
export function nearFailures<R extends RecallRecord>(memory: Iterable<[string, readonly R[]]>, selfHash: string, selfTargets: readonly string[] | null | undefined, since: (hash: string) => string, limit = 3): R[] {
  const key = targetSimilarityKey(selfTargets);
  if (!key) return [];
  const near: R[] = [];
  for (const [h, list] of memory) {
    if (h === selfHash) continue;
    for (const r of list) if (targetSimilarityKey(r.inferred) === key && r.at > since(h)) near.push(r);
  }
  near.sort((a, b) => b.at.localeCompare(a.at));
  return near.slice(0, limit);
}

const GOAL_TEXT_SHOWN = 120;
/** One recalled lesson from a DIFFERENT goal: its text, labelled, so the reader cannot take it for this goal. */
export function differentGoalLessonLine(r: RecallRecord): string {
  const t = stripDispatchIds(r.goal ?? "");
  const shown = t ? `"${t.length > GOAL_TEXT_SHOWN ? `${t.slice(0, GOAL_TEXT_SHOWN)}…` : t}"` : "(its text was not recorded)";
  return `- (${r.at.slice(0, 16)}) a DIFFERENT goal: ${shown} failed because ${r.reason}`;
}

/** The feedback attempt 1 receives: this goal's own verdicts (deterministic first), then labelled other-goal lessons. */
export function failureFeedbackText(exact: readonly RecallRecord[], near: readonly RecallRecord[]): string {
  if (exact.length === 0 && near.length === 0) return "";
  // Deterministic verdicts outrank LLM-judged ones: a judge that once credited a counterfeit can
  // also mis-grade a hollow, and a lesson built on a mis-grade steers the wrong way.
  const rank = (a: RecallRecord, b: RecallRecord) => Number(b.deterministic) - Number(a.deterministic) || b.at.localeCompare(a.at);
  const lines: string[] = [];
  for (const r of [...exact].sort(rank).slice(0, 3)) lines.push(`- (this exact goal, ${r.at.slice(0, 16)}, producer ${r.pick ?? "?"}) ${r.reason}`);
  // Other-goal lessons are normally shown only when the verdict was deterministic (an LLM-judged hollow on another goal is
  // weak signal). But if there are no deterministic failures AT ALL for this goal (neither exact nor near), an LLM-judged
  // near-miss is better than no lesson, so they are included as a fallback.
  const hasDeterministic = exact.some((r) => r.deterministic) || near.some((r) => r.deterministic);
  for (const r of near.filter((x) => !hasDeterministic || x.deterministic)) lines.push(differentGoalLessonLine(r));
  return lines.join("\n");
}

// Words that carry no subject (the concept-recall stop list, shared so the recall terms and the content check agree).
const CONTENT_STOP = new Set(["the", "and", "for", "that", "with", "from", "this", "into", "under", "are", "was", "how", "many", "what", "which", "then", "than", "when", "where", "file", "files", "using", "use", "report", "name", "list", "each"]);
/** A text's content tokens after its ids are stripped, longest first (concept recall's query terms). */
export function contentTermsOf(text: string): string[] {
  return [...new Set((stripDispatchIds(text).toLowerCase().match(/[a-z][a-z_]{3,}/g) ?? []).filter((w) => !CONTENT_STOP.has(w)))]
    .sort((a, b) => b.length - a.length);
}

/**
 * THE CONTENT CHECK (observe, never block): does a text the walk synthesised for this dispatch (a search query) share a
 * content token with the dispatch's own goal? A query with none is about some other subject. A goal with no content
 * token left after stripping cannot be checked, which is reported as unjudgeable rather than as a flag.
 */
export function offGoalContent(goal: string, text: string): { judgeable: boolean; flagged: boolean; goalTerms: string[]; textTerms: string[] } {
  const goalTerms = contentTermsOf(goal);
  const textTerms = contentTermsOf(text);
  if (goalTerms.length === 0 || textTerms.length === 0) return { judgeable: false, flagged: false, goalTerms, textTerms };
  const g = new Set(goalTerms);
  return { judgeable: true, flagged: !textTerms.some((t) => g.has(t)), goalTerms, textTerms };
}

/** In-process tally of the content check (the grounded-observe tally's pattern): checked, flagged, and unjudgeable. */
export const offGoalContentTally = { checked: 0, flagged: 0, unjudgeable: 0 };
/** Run the content check on one synthesised text, count it, and log a flagged one on `log` (the walk's tap). Never blocks. */
export function observeOffGoalContent(site: string, goal: string, text: string, log: (m: string) => void): boolean {
  const c = offGoalContent(goal, text);
  if (!c.judgeable) { offGoalContentTally.unjudgeable++; return false; }
  offGoalContentTally.checked++;
  if (!c.flagged) return false;
  offGoalContentTally.flagged++;
  log(`[goal-host-vessel] ${site}: OFF-GOAL CONTENT — the synthesised ${JSON.stringify(text.slice(0, 160))} shares no content word with this dispatch's goal (goal words: ${c.goalTerms.slice(0, 6).join(",")}); observed, not blocked (${offGoalContentTally.flagged} flagged of ${offGoalContentTally.checked} checked)`);
  return true;
}
