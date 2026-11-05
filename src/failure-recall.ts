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
  // Other-goal lessons are also ranked, with a preference for deterministic (alpha) verdicts. To avoid overwhelming
  // producers, total lessons are capped. Non-deterministic (beta) lessons are included to ensure even failures
  // with only beta-level signals can provide steering.
  if (lines.length < 4) {
    for (const r of [...near].sort(rank).slice(0, 4 - lines.length)) {
      lines.push(differentGoalLessonLine(r));
    }
  }
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

// RECALL IS AN ACTIVITY (goal-host:failure-recall; USER: "Build the filter now"). A compose cut at the caller used to be
// remembered as the attempt's own failure ("…; stage=unknown (caller cut at Ns, no report) …"), and those lessons are
// still on record and recalled: into the synthesis and floor prompts as "graded NOT REACHED", and as an exact record
// that turns command replay off. The cut fixes stopped writing them, but recorded nothing that tells an old one apart
// (a record has no class or source field), and the same text is still written for a failure that was not a cut.
//   - Every record written from now on carries outcome_source (where its reason came from).
//   - variant-0 (`goal-host:failure-recall`, the control): recall as before; outcome_source is not read.
//   - variant-1 (`goal-host:failure-recall-v1`): drops a LEGACY caller-cut lesson, a record with NO outcome_source whose
//     reason carries the cut text. The text is the only marker such a record has, so the clause is legacy-only: no
//     record written with a source can match it, and the set it can drop only shrinks as old records age out.
// Which variant a dispatch recalls under is the activityVariantMask pool impulse for this activity, read once per
// dispatch at its first recall (no row in force, an unreadable pool, an unknown variant: variant-0).

/** Where a remembered reason came from. */
export type FailureOutcomeSource = "graded" | "unconfirmed" | "non_attempt" | "dispatch_error";
/** The cut caller's outcome text (check-supply-ledger-reason.ts cutCallerReason with no lesson since the dispatch). */
export const LEGACY_CALLER_CUT_TEXT = "early edit-intent routed to feature_compose; stage=unknown (caller cut at ";
/** A legacy caller-cut lesson: written before records carried outcome_source, with the cut text in its reason. */
export function legacyCallerCutLesson(r: { reason: string; outcome_source?: unknown }): boolean {
  return r.outcome_source === undefined && typeof r.reason === "string" && r.reason.includes(LEGACY_CALLER_CUT_TEXT);
}

export const FAILURE_RECALL_ACTIVITY = "goal-host:failure-recall";
export const FAILURE_RECALL_CREDIT_ACTIVITY = "goal-host:failure-recall-credit";
export const failureRecallVariantId = (variant: number): string => (variant === 0 ? FAILURE_RECALL_ACTIVITY : `${FAILURE_RECALL_ACTIVITY}-v${variant}`);
const FAILURE_RECALL_VARIANTS = [0, 1] as const;
type MaskRow = { id?: string; body?: unknown };
/** The variant in force at `nowIso` from the open mask rows (newest first): the first row for this activity whose
 *  [from, until) holds now. No such row, or an unknown variant: variant-0. */
export function failureRecallVariant(nowIso: string, rows: readonly MaskRow[] | null): { variant: number; why: string } {
  if (rows === null) return { variant: 0, why: "mask_unread: variant-0" };
  const now = Date.parse(nowIso);
  for (const r of rows) {
    const b = (r?.body ?? {}) as Record<string, unknown>;
    if (b["activity_id"] !== FAILURE_RECALL_ACTIVITY) continue;
    const from = Date.parse(String(b["from"] ?? "")), until = Date.parse(String(b["until"] ?? ""));
    if (!Number.isFinite(from) || !Number.isFinite(until) || now < from || now >= until) continue;
    const v = b["active_variant"];
    if (typeof v !== "number" || !(FAILURE_RECALL_VARIANTS as readonly number[]).includes(v)) return { variant: 0, why: `mask ${String(r.id)} names unknown variant ${JSON.stringify(v)}: variant-0` };
    return { variant: v, why: `mask ${String(r.id)} [${String(b["from"])}, ${String(b["until"])}) by ${String(b["by"])}: ${String(b["reason"])}` };
  }
  return { variant: 0, why: "no mask in force: variant-0" };
}

/** One dispatch's recall decision: the variant, and what variant-1's clause removes (or would remove under variant-0). */
export interface FailureRecallDecision {
  variant: number;
  why: string;
  exact_before: number;
  exact_after: number;
  near_before: number;
  near_after: number;
  /** the records variant-1's clause matched: removed under variant-1, kept (would_filter) under variant-0 */
  matched: Array<{ hash: string; at: string; why: string }>;
  /** variant-1 removed the only exact records, so command replay is no longer turned off for this goal */
  reuse_enabled_by_filter: boolean;
}
export function failureRecallDecision<R extends RecallRecord & { outcome_source?: unknown }>(variant: number, why: string, exact: readonly R[], near: readonly R[]): FailureRecallDecision {
  const matched = [...exact, ...near].filter((r) => legacyCallerCutLesson(r)).map((r) => ({ hash: r.hash, at: r.at, why: "legacy caller-cut lesson (no outcome_source; cut text in the reason)" }));
  const keep = (l: readonly R[]) => (variant === 1 ? l.filter((r) => !legacyCallerCutLesson(r)) : l);
  const exactAfter = keep(exact).length;
  return { variant, why, exact_before: exact.length, exact_after: exactAfter, near_before: near.length, near_after: keep(near).length, matched, reuse_enabled_by_filter: variant === 1 && exact.length > 0 && exactAfter === 0 };
}
/** The recall's own trace: one deterministic task, input goal, output failureRecall. */
export function failureRecallTrace(d: FailureRecallDecision, goalHash: string, dispatchId: string, nowIso: string): Record<string, unknown> {
  const id = failureRecallVariantId(d.variant);
  const executionId = `failure-recall-${goalHash}-${Date.parse(nowIso) || Date.now()}-${dispatchId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36)}`;
  return {
    execution_id: executionId, template_id: id, activity_id: id, activity_variant_id: id,
    status: "completed", success: true, started_at: nowIso, duration_ms: 0,
    input_shapes: ["goal"], output_shapes: ["failureRecall"],
    tasks: [{ id: "recall", resolver_id: "deterministic", resolver_tier: "deterministic", success: true, input_impulse_ids: [], output_impulse_ids: [`failureRecall:${executionId}`] }],
    tags: [`failure_recall_variant:${d.variant}`, `dispatch:${dispatchId}`],
    metadata: { goal_hash: goalHash, dispatch_id: dispatchId, failureRecall: { ...d, filtered: d.variant === 1 ? d.matched.length : 0, would_filter: d.variant === 1 ? 0 : d.matched.length } },
  };
}
/** The consumer trace that grades a recall: reached = the consuming dispatch's decided verdict. */
export function failureRecallCreditTrace(producerExecutionId: string, variant: number, reached: boolean, matched: number, nowIso: string): Record<string, unknown> {
  const impulse = `failureRecall:${producerExecutionId}`;
  return {
    execution_id: `failure-recall-credit-${producerExecutionId.replace(/^failure-recall-/, "")}`,
    template_id: FAILURE_RECALL_CREDIT_ACTIVITY, activity_id: FAILURE_RECALL_CREDIT_ACTIVITY, activity_variant_id: FAILURE_RECALL_CREDIT_ACTIVITY,
    status: reached ? "completed" : "failed", success: reached,
    ...(reached ? {} : { failure_mode: { type: "verifier_negative", reason: "the dispatch that consumed this recall was judged not reached" } }),
    started_at: nowIso, duration_ms: 0, composition_chain: [producerExecutionId],
    tasks: [{ id: "judge-consuming-dispatch", resolver_id: "deterministic", resolver_tier: "deterministic", success: reached, input_impulse_ids: [impulse], output_impulse_ids: [],
      consumed_provenance: [{ impulse_id: impulse, producer_execution_id: producerExecutionId, origin: "ancestor" }] }],
    tags: [reached ? "reached:true" : "reached:false", `failure_recall_variant:${variant}`],
    metadata: { producer_execution_id: producerExecutionId, variant, matched },
  };
}
