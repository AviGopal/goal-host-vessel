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

/** Number of corpus rows read per consumption. */
export const ORACLE_LABEL_FETCH_LIMIT = 1;

/** Choose the row the consumer acts on. */
export function pickConsumableLabel(labels: OracleLabelRow[]): OracleLabelRow | undefined {
  return labels[0];
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
      body: JSON.stringify({ pointer: { type: "goal_verification_label", execution_id: labelExecId, limit: ORACLE_LABEL_FETCH_LIMIT } }),
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
