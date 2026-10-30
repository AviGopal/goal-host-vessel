// A JUDGE-ONLY REACH IS GRADED BY A PERSON'S VERDICT, NOT BY THE JUDGE ALONE (USER ruling 2026-10-29T22:38:47Z,
// "Person verdict counts").
//
// A JUDGE-ONLY reach is one the LLM judge alone called reached: reached=true, the verdict is not deterministic, and
// the walk WITHHELD alpha because the chain formed no in-chain producer-to-consumer edge (index.ts credit gate). Before
// this, the walk-complete POST /reach still graded it on arrival, so a judge's yes credited the arm with nothing but
// the judge behind it. Now its walk-complete /reach is DEFERRED: the dispatch record carries the deferral
// (reach_decided_by:person) and a PERSON's label (oracle-label-consumer.ts isPersonPrincipal) decides it:
//   - person "achieved"      -> the same deliverReachVerdict with reached=true (alpha), and the reach is minted,
//                               grounded by the person;
//   - person "not_achieved"  -> deliverReachVerdict with reached=false (beta); no mint;
//   - person "partial"       -> resolved UNGRADED (no alpha, no beta);
//   - an OBSERVE dispatch's deferral -> resolved UNGRADED whatever the person says (observe grades no posterior);
//   - no person verdict within the window -> resolved UNGRADED-expired: no /reach at all, recorded on the record.
// BANK PERSISTENCE: the walk's bank candidate rides on the deferral (bounded, never served or logged) and is banked,
// basis "concurring" with the person's provenance, only on a person's "achieved" and never under observe. It is never
// banked over an existing entry for the goal or over a tombstone written since the walk, and it is cleared whenever the
// deferral resolves.
// Every other verdict (reached=false, deterministic, an alpha-credited reach) is delivered at walk end as before.
// An operator key's verdict:human row and an agent's automated row decide nothing here: only a person's does.
//
// RETENTION: an OPEN deferral keeps its dispatch record (index.ts pruneStore neither compacts nor drops it) until it
// is decided or its window ends. The window is the shaped tuning row personVerdictWindowMs (selection-tuning.ts,
// default 7 days). The durable trace the person-reached mint re-reads is protected in the trace store by the label
// row its verdict already wrote (activity-api trace-retention: label execution ids are protected).

import type { BankCandidate } from "./reached-command-store";

export type DeferralState = "open" | "delivered" | "ungraded" | "expired" | "judge-fallback";

/** BANK PERSISTENCE: what a deferral may carry of the walk's bank candidate. A larger command is not carried. */
export const BANK_LIMITS = Object.freeze({ commandMaxChars: 4_000, goalTextMaxChars: 2_000, targetShapesMax: 32 });

/** The walk's bank candidate, bounded for the deferral (BANK_LIMITS); null when absent or its command is too large. */
export function boundBankCandidate(c: BankCandidate | null | undefined): BankCandidate | null {
  if (!c || typeof c.command !== "string" || !c.command.trim() || c.command.length > BANK_LIMITS.commandMaxChars) return null;
  return {
    command: c.command,
    field: c.field,
    shape: c.shape,
    targetShapes: (c.targetShapes ?? []).slice(0, BANK_LIMITS.targetShapesMax),
    goalText: String(c.goalText ?? "").slice(0, BANK_LIMITS.goalTextMaxChars),
  };
}

/** What a deferred walk-complete /reach needs later, beyond what the durable trace carries. */
export interface DeferredReach {
  executionId: string;
  completionShapes: string[];
  reason: string | null;
  goalHash: string | null;
  /** The beta-withhold reason the walk recorded for this execution, if any (carried into the person's /reach). */
  betaWithheldReason: string | null;
  /** Who originated the dispatch (record.initiator, from the validated principal): "system" for a node-self goal.
   *  A system-originated deferral waits only selfGoalVerdictWindowMs, then falls back to the judge's grading. */
  originator?: "system" | "operator" | null;
  /** The dispatch's learning mode, captured at walk end: an OBSERVE dispatch's deferral resolves ungraded. */
  learningMode?: "observe" | "learn" | null;
  /** BANK PERSISTENCE: the walk's bank candidate (bounded), banked only on a PERSON's "achieved". Never served or
   *  logged (its length and shape only); cleared when the deferral resolves. */
  bank?: BankCandidate | null;
  /** The reached-command store's size (bytes) at walk end: a tombstone appended after it blocks the person's bank. */
  bankStoreMark?: number;
  deferredAt: number;
  state: DeferralState;
  decidedAt?: number;
  /** "achieved" | "not_achieved" | "partial", or "no person verdict" on expiry. */
  decision?: string;
}

/** The alpha-withheld reason the walk records for a reach whose chain formed no in-chain edge. */
export const ALPHA_WITHHELD_NO_EDGE = "no-in-chain-edge";

/** Is this walk-complete verdict a JUDGE-ONLY reach, deferred to a person? */
export function isJudgeOnlyReach(reached: unknown, reason: string | null | undefined, alphaWithheldReason: string | null | undefined): boolean {
  return reached === true && !/^deterministic:/.test(String(reason ?? "")) && alphaWithheldReason === ALPHA_WITHHELD_NO_EDGE;
}

export function openDeferral(a: Omit<DeferredReach, "state" | "deferredAt">, now: number): DeferredReach {
  return { ...a, completionShapes: [...a.completionShapes], deferredAt: now, state: "open" };
}

/** Does an open deferral keep its record from compaction and deletion? Only while it is open. */
export function retainsRecord(d: DeferredReach | null | undefined): boolean {
  return !!d && d.state === "open";
}

/** SELF-GOALS EXPIRE TO JUDGE (USER ruling 2026-10-30T03:21:09Z): the window an open deferral waits for a person. A
 *  system-originated deferral (node-self, no person principal) waits selfGoalVerdictWindowMs; every other one keeps
 *  personVerdictWindowMs. Both are shaped tuning rows (selection-tuning.ts). */
export function deferralWindowMs(d: DeferredReach | null | undefined, w: { personVerdictWindowMs: number; selfGoalVerdictWindowMs: number }): number {
  return d?.originator === "system" ? w.selfGoalVerdictWindowMs : w.personVerdictWindowMs;
}

/** What an expired deferral resolves to: a system-originated, learning deferral falls back to the judge's walk-end grading
 *  (its /reach is delivered as the judge said; alpha is still withheld at the walk's credit gate, and nothing is banked
 *  or minted on the judge's word alone); every other one resolves ungraded with no /reach. */
export function expiryOutcome(d: DeferredReach): "judge-fallback" | "ungraded" {
  return d.originator === "system" && d.learningMode !== "observe" ? "judge-fallback" : "ungraded";
}

/** Resolve an open deferral to the judge's walk-end grading (self-goals). Returns false if not open. */
export function judgeFallbackDeferral(d: DeferredReach, now: number): boolean {
  if (d.state !== "open") return false;
  d.state = "judge-fallback";
  d.decidedAt = now;
  d.decision = "no person verdict: judge grading";
  d.bank = null;
  return true;
}

/** Has an open deferral outlived its window (deferralWindowMs)? */
export function deferralExpired(d: DeferredReach | null | undefined, now: number, windowMs: number): boolean {
  return !!d && d.state === "open" && now - d.deferredAt >= windowMs;
}

/** Resolve an open deferral as UNGRADED-expired: no alpha, no beta, no /reach; recorded. Returns false if not open. */
export function expireDeferral(d: DeferredReach, now: number): boolean {
  if (d.state !== "open") return false;
  d.state = "expired";
  d.decidedAt = now;
  d.decision = "no person verdict";
  d.bank = null;
  return true;
}

/** A person's verdict on an open deferral: what to deliver. null = nothing to deliver (not open). */
export function personDecision(d: DeferredReach | null | undefined, verdict: string): { deliver: boolean; reached: boolean | null; mint: boolean } | null {
  if (!d || d.state !== "open") return null;
  // An OBSERVE dispatch grades no posterior (observe-mode.ts): the person's verdict is recorded, nothing is delivered.
  if (d.learningMode === "observe") return { deliver: false, reached: verdict === "achieved" ? true : verdict === "not_achieved" ? false : null, mint: false };
  if (verdict === "achieved") return { deliver: true, reached: true, mint: true };
  if (verdict === "not_achieved") return { deliver: true, reached: false, mint: false };
  return { deliver: false, reached: null, mint: false };
}

/** Map an activity-api GET /v2/activities/execution-traces/:id body to the trace mintReachedTrace reads. */
export function mintTraceFromStore(body: unknown): { id?: string; status?: string; templateId?: string; durationMs?: number; costUsd?: number; tasks?: Array<{ outputShapes?: string[] }>; compositionChain?: string[]; outputImpulseIds?: string[]; metadata?: Record<string, unknown> } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const t = (b["execution_trace"] && typeof b["execution_trace"] === "object") ? b["execution_trace"] as Record<string, any> : null;
  const id = String(t?.["id"] ?? b["execution_id"] ?? "");
  if (!id) return null;
  return {
    id,
    status: String(t?.["status"] ?? b["status"] ?? "completed"),
    templateId: t?.["templateId"] ?? b["activity_id"],
    durationMs: t?.["durationMs"] ?? b["duration_ms"],
    costUsd: t?.["costUsd"] ?? b["cost_usd"],
    tasks: (Array.isArray(t?.["tasks"]) ? t!["tasks"] : Array.isArray(b["tasks"]) ? b["tasks"] : []) as Array<{ outputShapes?: string[] }>,
    compositionChain: t?.["compositionChain"] ?? b["composition_chain"],
    outputImpulseIds: t?.["outputImpulseIds"] ?? [],
    metadata: t?.["metadata"] ?? b["metadata"],
  };
}
