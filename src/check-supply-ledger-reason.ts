// WHAT A CHECK-SUPPLY LEDGER LINE SAYS ABOUT ITS COMPOSE: the stage and reason that ended it, when goal-host can know
// them. The ledger reads goal-host's goalReachReason, so a reason that names no stage teaches the supply nothing.
//
// Measured (goal-host journals, 30 h on two nodes):
//   - "check_supply compose refused at (none) (verdict=UNFAVORABLE)" 66 times. An UNFAVORABLE report carries no
//     top-level `stage`; the stage that refused it is implied by the report (a semantic-gate dissent, a failure_kind).
//     composeReportStage names it.
//   - "the check_supply compose call failed or was refused and nothing landed for <gap>" on each caller cut (36 timeouts
//     and socket closes). That path holds NO compose report: the call was cut before the reply. The compose itself ran on
//     and recorded its outcome on the gap row (classification_metadata.failure_lessons), so cutCallerOutcome reads the
//     newest lesson recorded since this dispatch started. An older lesson belongs to an earlier attempt and is never
//     reported as this one's: the line then says stage=unknown. check_supply.reason is not read, because it is the
//     ledger's own copy of an earlier line like this one.

const REASON_MAX = 300;

/** The stage that ended a compose report: its own `stage`, else what the report implies, else "(none)". */
export function composeReportStage(body: Record<string, unknown> | null | undefined): string {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.stage === "string" && b.stage.trim()) return b.stage.trim();
  const sg = b.semantic_gate as { addresses?: unknown } | null | undefined;
  if (sg && typeof sg === "object" && sg.addresses === false) return "semantic_gate";
  if (typeof b.failure_kind === "string" && b.failure_kind.trim()) return b.failure_kind.trim();
  if (typeof b.verdict === "string" && b.verdict.trim()) return b.verdict.trim();
  return "(none)";
}

interface Lesson { at?: unknown; stage?: unknown; class?: unknown; reason?: unknown; raw_excerpt?: unknown }

/**
 * The outcome a cut caller can still report: ` stage=<stage> reason=<text>` from the gap row's newest failure lesson
 * recorded after `dispatchStartMs` (bounded), else ` stage=unknown (caller cut at <n>s, no report)`, n = seconds from
 * dispatch start to the cut (the caller passes the elapsed time when no cut was timed).
 */
export function cutCallerOutcome(
  row: { classification_metadata?: Record<string, unknown> } | null | undefined,
  dispatchStartMs: number,
  cutAtS: number,
): string {
  const lessons = row?.classification_metadata?.["failure_lessons"];
  let newest: { t: number; l: Lesson } | null = null;
  for (const l of Array.isArray(lessons) ? (lessons as Lesson[]) : []) {
    const t = typeof l?.at === "string" ? Date.parse(l.at) : NaN;
    if (Number.isFinite(t) && t >= dispatchStartMs && (!newest || t > newest.t)) newest = { t, l };
  }
  if (!newest) return ` stage=unknown (caller cut at ${cutAtS}s, no report)`;
  const l = newest.l;
  const stage = (typeof l.stage === "string" && l.stage.trim()) || (typeof l.class === "string" && l.class.trim()) || "unknown";
  const reason = (typeof l.reason === "string" && l.reason.trim()) || (typeof l.raw_excerpt === "string" && l.raw_excerpt.trim()) || "(no reason recorded)";
  return ` stage=${stage} reason=${reason}`.slice(0, REASON_MAX);
}

/**
 * The cut caller's ledger line. The outcome (` stage=<s> reason=<r>`) comes BEFORE the gap id: readers keep only a
 * prefix of the line (the supply's ledger keeps its first 240 characters), and with the outcome after a long gap id
 * the stage was cut off, so the ledger said again only "nothing landed".
 */
export function cutCallerReason(gapId: string, outcome: string): string {
  return `early edit-intent routed to feature_compose;${outcome} - the check_supply compose call failed or was refused and nothing landed for ${gapId} - a check-supply goal is never walked or escalated`;
}
