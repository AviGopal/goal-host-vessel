/**
 * Poll-time oracle-label consumption — SHARED by GET /executions/:id AND the
 * goalWalkState resolve branch (both call maybeConsumeOracleLabel in index.ts,
 * which delegates here). The Obsidian panel polls goalWalkState, so the consumer
 * MUST run there too; otherwise a human reach override is written to the oracle
 * corpus, shown 'recorded', and silently NEVER applied on the read path.
 *
 * A HUMAN verdict corrects record.reached + surfaces directed notes (corrective, law 13);
 * reach is NEVER posterior-written — the arm already earns reach credit via
 * v_shape_conditioned_score (FROM execution.success), so re-writing a β would
 * double-count and could β-condemn a correctly-selected arm on an unreachable goal (law 12).
 *
 * Extracted from index.ts so the consumer's effects (record mutation, the latch, the
 * disagreement-gap POST) are observable through an injected fetch rather than only by
 * reading source text.
 */

export interface OracleLabelRow {
  verdict?: string;
  notes?: string;
  labeler?: string;
  /** "calibration" marks a blind-calibration-sheet verdict; such a row influences nothing. */
  purpose?: string;
  window_id?: string;
  sample_draw_id?: string;
  /**
   * Stamped by activity-api's label writer from the SERVER-VALIDATED credential of a human label
   * (migration 219); never caller-settable there. Rows written before that carry none.
   */
  labeled_by_principal?: { key_id?: unknown; auth_type?: unknown; scopes?: unknown } | null;
}

/**
 * WHO A HUMAN VERDICT MUST COME FROM. A labeler:"human" row overrides record.reached and files a
 * human_reported disagreement gap, so it is acted on only when activity-api stamped it with a
 * principal whose validated scopes carry the human-verdict scope ("verdict:human", or "admin" as
 * the interim fallback until a verdict-scoped operator key is issued), attributable by key id.
 * The scope names match activity-api's src/routes/goal-verification-label-write.ts. Anything
 * else (no stamp, a malformed stamp, a stamp without the scope) is NOT a human verdict: it is
 * ignored, counted, and logged. Fail closed: every row written before the stamp existed is ignored.
 */
export const HUMAN_VERDICT_SCOPE = "verdict:human";
export const ADMIN_SCOPE = "admin";
export function hasHumanVerdictPrincipal(label: OracleLabelRow | undefined): boolean {
  const p = label?.labeled_by_principal;
  if (!p || typeof p !== "object") return false;
  if (typeof p.key_id !== "string" || p.key_id.trim().length === 0) return false;
  const scopes = Array.isArray(p.scopes) ? p.scopes : [];
  return scopes.includes(HUMAN_VERDICT_SCOPE) || scopes.includes(ADMIN_SCOPE);
}

/** Human-labeled rows ignored for want of a human-verdict principal (one per execution id, process lifetime). */
const ignoredHumanLabelExecs = new Set<string>();
let ignoredHumanLabelCount = 0;
/** How many executions had a human label ignored for want of a human-verdict principal. */
export function oracleLabelIgnoredHumanCount(): number {
  return ignoredHumanLabelCount;
}
/** Tests only. */
export function __resetOracleLabelCountersForTests(): void {
  ignoredHumanLabelExecs.clear();
  ignoredHumanLabelCount = 0;
}

/** The slice of DispatchRecord the consumer reads and writes. */
export interface OracleLabelRecord {
  status: string;
  executionId?: string | null;
  goal?: unknown;
  reached?: boolean | null;
  goalReachReason?: string | null;
  humanGraded?: boolean;
  humanReachNotes?: string;
  learning?: { oracleLabelWritten: boolean } | null;
}

export interface OracleLabelDeps {
  activityApiEndpoint: string;
  devVesselEndpoint: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * The read: the newest NON-calibration rows, newest first. activity-api serves the exclusion
 * (`exclude_purpose`: rows whose purpose is absent or differs), so any number of newer
 * calibration rows cannot hide an ordinary verdict. The client-side check in pickConsumableLabel
 * stays as a second layer for an activity-api that predates exclude_purpose.
 *
 * WHY A WINDOW, NOT ONE ROW: a human-labeled row without a human-verdict principal is ignored
 * (hasHumanVerdictPrincipal), and with a one-row read such a row, while newest, hid every older
 * row — including a genuine operator verdict. The label read has no principal filter, so the
 * consumer reads a bounded window and picks in code. The bound is the resolver's default page:
 * more than this many newer unprincipalled human rows on one execution still hide an older verdict.
 */
export const ORACLE_LABEL_FETCH_LIMIT = 20;
export const ORACLE_LABEL_EXCLUDE_PURPOSE = "calibration";

/**
 * A calibration label (purpose "calibration") comes from a BLIND calibration sheet: a human
 * judges sealed runs to measure the judge's accuracy. It must INFLUENCE NOTHING — no reach
 * override, no latch, no disagreement gap — or the measurement feeds back into the thing it
 * measures (law 12). The surface reads these rows for its calibration report; nothing else may.
 */
export function isCalibrationLabel(label: OracleLabelRow | undefined): boolean {
  return label?.purpose === "calibration";
}

/** A labeler:"human" row that does not carry a human-verdict principal: never acted on. */
export function isUnprincipalledHumanLabel(label: OracleLabelRow | undefined): boolean {
  return label?.labeler === "human" && !hasHumanVerdictPrincipal(label);
}

/**
 * Choose the row the consumer acts on: the newest row that is neither a calibration label nor an
 * unprincipalled human label (so an ignored row cannot hide an older one beneath it).
 */
export function pickConsumableLabel(labels: OracleLabelRow[]): OracleLabelRow | undefined {
  return labels.find((l) => !isCalibrationLabel(l) && !isUnprincipalledHumanLabel(l));
}

/**
 * WHICH LABEL RESPONSES index.ts's read cache may keep. The cache never re-reads a kept body, so
 * it may keep only a response the consumer will never need to read again: one whose consumable
 * row is a genuine human verdict (that burns the latch, so the execution is never polled again).
 * Anything else must be re-read: an automated row (a later human verdict must surface — the
 * source-aware latch), an unprincipalled human row (a later genuine verdict must surface), a
 * calibration row, no row. Unparseable → not cacheable.
 */
export function isCacheableLabelResponse(text: string): boolean {
  try {
    const payload = JSON.parse(text) as { content?: unknown } | null;
    const content = payload?.content;
    const rows = typeof content === "string" ? JSON.parse(content) : content;
    if (!Array.isArray(rows)) return false;
    const label = pickConsumableLabel(rows as OracleLabelRow[]);
    return label?.labeler === "human" && hasHumanVerdictPrincipal(label);
  } catch {
    return false;
  }
}

/**
 * Consume the newest label for record.executionId. Resolves when consumption (and any
 * gap POST it starts) has been issued; never throws.
 */
export async function consumeOracleLabel(record: OracleLabelRecord, deps: OracleLabelDeps): Promise<void> {
  const learn = record.learning;
  if (!(record.status !== "running" && learn && !learn.oracleLabelWritten && record.executionId)) return;
  const doFetch = deps.fetchImpl ?? fetch;
  const auth: Record<string, string> = deps.apiKey ? { Authorization: `ApiKey ${deps.apiKey}` } : {};
  const labelExecId = record.executionId;
  try {
    const labelRes = await doFetch(`${deps.activityApiEndpoint}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ pointer: { type: "goal_verification_label", execution_id: labelExecId, limit: ORACLE_LABEL_FETCH_LIMIT, exclude_purpose: ORACLE_LABEL_EXCLUDE_PURPOSE } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!labelRes.ok) {
      console.warn(`[oracle-label] NOT consumed exec=${labelExecId} reason=fetch_not_ok status=${labelRes.status}`);
      return;
    }
    const labelPayload = (await labelRes.json().catch(() => null)) as { content?: string } | null;
    let labels: OracleLabelRow[] = [];
    try { labels = labelPayload?.content ? (JSON.parse(labelPayload.content) as OracleLabelRow[]) : []; } catch { labels = []; }
    const label = pickConsumableLabel(labels);
    // Unprincipalled human rows NEWER than the row acted on (or all of them, when none is acted on).
    const pickedAt = label ? labels.indexOf(label) : labels.length;
    const ignoredHuman = labels.slice(0, pickedAt).filter((l) => !isCalibrationLabel(l) && isUnprincipalledHumanLabel(l));
    const skippedCalibration = labels.length - labels.filter((l) => !isCalibrationLabel(l)).length;
    if (skippedCalibration > 0) {
      console.log(`[oracle-label] skipped ${skippedCalibration} calibration label(s) for ${labelExecId} (purpose=calibration influences nothing)`);
    }
    // A "human" row without a human-verdict principal is NOT a human verdict (hasHumanVerdictPrincipal).
    // It is skipped by pickConsumableLabel, so it cannot block or hide a genuine override; counted and
    // logged once per execution (this runs on every poll).
    if (ignoredHuman.length > 0 && !ignoredHumanLabelExecs.has(String(labelExecId))) {
      ignoredHumanLabelExecs.add(String(labelExecId));
      ignoredHumanLabelCount += 1;
      console.warn(`[oracle-label] human label IGNORED: no operator principal exec=${labelExecId} verdict=${String(ignoredHuman[0]!.verdict)} ignored_total=${ignoredHumanLabelCount}`);
    }
    if (!label && (skippedCalibration > 0 || ignoredHuman.length > 0)) return;
    const labelVerdict = label?.verdict;
    if (labelVerdict !== "achieved" && labelVerdict !== "not_achieved" && labelVerdict !== "partial") {
      const reason = labels.length === 0 ? "no_labels" : (labelVerdict === undefined ? "verdict_field_missing" : "verdict_unrecognised");
      console.warn(`[oracle-label] NOT consumed exec=${labelExecId} reason=${reason} n_labels=${labels.length} verdict=${String(labelVerdict)} labeler=${label?.labeler ?? "<none>"}`);
      return;
    }
    // SOURCE-AWARE LATCH: only a HUMAN verdict burns the consumption latch.
    // recordDeterministicLabel mirrors EVERY oracle verdict into the corpus as a
    // deterministic/automated row at verdict time, so a machine label is always
    // present before the operator can speak. Burning the latch on it made the human
    // branch below structurally unreachable — 0 "HUMAN reach override" lines in 48h
    // against 81 machine consumptions. Leaving the latch unburned for machine labels is
    // sufficient: the corpus read is ORDER BY created_at DESC (activity-api
    // src/routes/impulses.ts), so a later human row is already first on the next poll.
    if (label?.labeler === "human") learn.oracleLabelWritten = true;
    if (label?.labeler === "human") {
      const priorReached = record.reached;
      record.reached = labelVerdict === "achieved" ? true : labelVerdict === "not_achieved" ? false : null;
      // ORACLE-DISAGREEMENT WIRE (2026-09-19). A human verdict that CONTRADICTS the
      // system's own reach verdict is direct evidence the grading pipeline judged this
      // goal class wrongly. Mint the repair gap automatically — deduplicated by execution
      // id (idempotent upsert), fire-and-forget, fail-open, with the failure logged in the
      // catch so a silent drop is observable.
      if (priorReached !== null && record.reached !== null && priorReached !== record.reached) {
        const dgapId = "gap-oracle-label-disagreement-" + String(labelExecId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
        void doFetch(`${deps.devVesselEndpoint}/v2/impulses/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify({ impulse: { type: "substrateGap_write", pointer: { type: "substrateGap_write", gap: { id: dgapId, source: "human_reported", summary: `Human ground-truth label contradicts the system reach verdict for execution ${labelExecId}: system graded reached=${String(priorReached)}, human graded ${labelVerdict}. Goal: ${String(record.goal ?? "").slice(0, 200)}. Human notes: ${String(label?.notes ?? "").slice(0, 300)}. The grading pipeline judged this goal class wrongly; determine why the verdicts diverge and repair the grader for the class, preserving honest grading.`, detected_at: new Date().toISOString() } } } }),
          signal: AbortSignal.timeout(10_000),
        }).then((r) => console.log(`[oracle-label] disagreement gap ${dgapId} filed (http ${r.status})`)).catch((e) => console.warn(`[oracle-label] disagreement gap filing failed (non-fatal): ${(e as Error).message}`));
      }
      record.humanGraded = true;
      const notes = typeof label?.notes === "string" ? label.notes.trim() : "";
      record.humanReachNotes = notes;
      record.goalReachReason = `[human override: ${notes || ("reached=" + String(record.reached))}] ${record.goalReachReason ?? ""}`.slice(0, 600);
      console.log(`[oracle-label] HUMAN reach override verdict=${labelVerdict} for ${labelExecId} -> record.reached=${record.reached} (no posterior β-penalty)`);
    } else {
      console.log(`[oracle-label] consumed automated verdict=${labelVerdict} for ${labelExecId} (no override)`);
    }
  } catch (e) {
    console.warn(`[oracle-label] consumption failed (non-fatal): ${(e as Error).message}`);
  }
}
