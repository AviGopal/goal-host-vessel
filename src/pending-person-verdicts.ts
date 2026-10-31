// RUNS AWAITING A PERSON'S VERDICT, SERVED (the person-verdict pipe).
//
// A judge-only reach is deferred to a person (person-verdict.ts), but the deferral lived only on the in-memory dispatch
// record: no shape served it, so no surface could ask anyone, and in 48 h of journals no person row ever reached a
// deferral. This module is the read side, served through the EXISTING activeDispatches read (no new shape):
//   - `awaiting: "person_verdict"` filters the read to OPEN deferrals, server-side. The read is otherwise the newest 50
//     records, and an open deferral is retained for up to its window, so a client-side filter would miss older ones.
//   - each row (and goalWalkState) carries `personVerdict`, a bounded view: never the bank candidate, the compact trace
//     copy or the store mark, which person-verdict.ts says are never served.
// The answer path is unchanged: a person's goal_verification_label row, decided by oracle-label-consumer.ts.
//
// Why not the resolverRequest queue: its sweep withdraws a request whose dispatch has ended, and a deferral exists only
// after walk-complete; it has no list read; and it is answered by a lease or solicitationResponse_write, not by a
// person's label.

import { deferralWindowMs, effectiveOriginator, type DeferredReach } from "./person-verdict";

/** The filter value of `activeDispatches.awaiting` that lists open deferrals. */
export const AWAITING_PERSON_VERDICT = "person_verdict";

type RecordLike = { deferredReach?: DeferredReach | null; initiator?: string | null; principal?: { kind?: string } | null };
type Windows = { personVerdictWindowMs: number; selfGoalVerdictWindowMs: number };

/** What a reader is told about a deferral. Times are ms epoch, as the row's startedAt. */
export interface PersonVerdictView {
  executionId: string;
  state: DeferredReach["state"];
  deferredAt: number;
  /** deferredAt + the window the expiry sweep judges it by (shaped tuning rows). */
  expiresAt: number;
  originator: "system" | "operator" | null;
}

/** Does this record wait for a person's verdict? Only an OPEN deferral does (expiry also sets reachDecidedBy). */
export function awaitsPersonVerdict(r: RecordLike): boolean {
  return r.deferredReach?.state === "open";
}

/** The bounded view of the record's deferral, or null when it has none. */
export function personVerdictView(r: RecordLike, w: Windows): PersonVerdictView | null {
  const d = r.deferredReach;
  if (!d) return null;
  const originator = effectiveOriginator(d, { initiator: r.initiator ?? null, principal: r.principal ?? null }) ?? null;
  return {
    executionId: d.executionId,
    state: d.state,
    deferredAt: d.deferredAt,
    expiresAt: d.deferredAt + deferralWindowMs({ ...d, originator }, w),
    originator,
  };
}
