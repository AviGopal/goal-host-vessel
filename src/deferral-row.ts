// AN OPEN PERSON-VERDICT DEFERRAL ALWAYS HAS A ROW TO GRADE.
//
// Gap an-open-person-verdict-deferral-has-no-protected-durable-row-so-a-late-verdict-or-fallback-matches-no-row-and-the-
// run-stays-ungraded. ONE CAUSE: a judge-only reach's durable trace is persisted UNTAGGED on purpose (no α on the judge's
// word), untagged is UNGRADED, and activity-api trace-retention's UNGRADED_WHERE deletes ungraded rows. By the time a
// person's verdict, or a self-goal's judge fallback, sends its /reach, the row can be gone: "reach-patch MATCHED NO ROW
// ... stays ungraded" (seen on pre-stamp fallbacks; and on every walk-satisfier-* deferral whose row was pruned).
//
// The fix, all through existing paths:
//   - the deferral keeps a BOUNDED compact copy of the durable trace it defers (ids, shapes and statuses only, never
//     content; at most COMPACT_TRACE_MAX_BYTES serialized, else tasks are dropped). It is never served or logged (the
//     same rule as d.bank);
//   - when the decision's /reach matches no row, the copy is re-inserted GRADED through the existing grade-at-insert
//     sink: a person's achieved is reached:true (α on the person's word), not achieved reached:false (β), and a judge
//     fallback reached:true with the existing beta_withheld markers, which activity-api's insert path reads to apply no
//     α/β (no α on the judge's word, as at the deferral gate). Every re-insert carries reinserted_from_deferral:<id> and
//     decided_by:<person|judge-fallback>, so it is never taken for an original run;
//   - a deferral with nothing to patch (a synthetic id, or a satisfier reach whose durable trace was never persisted) is
//     refused at open: the verdict is delivered at once, as before deferral existed, with the reason logged.
// Protecting the row from retention while the deferral is open (activity-api trace_evidence_ref has a reader but no
// writer) is a separate activity-api task; this module does not depend on it.

import type { ExecutionTrace } from "@avigopal/ias-executor-ts";
import { withBetaWithheld } from "./satisfier-durable-trace";

export const COMPACT_TRACE_MAX_BYTES = 8_192;
export const COMPACT_TRACE_TASK_CAP = 40;
export const COMPACT_TRACE_TAG_CAP = 32;

export interface CompactTrace {
  id: string;
  templateId?: string;
  templateName?: string;
  compositionChain?: string[];
  tasks: Array<{ taskId?: string; resolverId?: string; outputShapes?: string[]; success?: boolean }>;
  tags: string[];
}

/** The bounded copy of a durable trace a deferral keeps: ids, shapes and statuses, never content or metadata. */
export function compactDeferralTrace(t: ExecutionTrace | null | undefined): CompactTrace | null {
  if (!t || typeof t.id !== "string" || !t.id) return null;
  const x = t as unknown as Record<string, unknown>;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const tasks = (Array.isArray(x["tasks"]) ? (x["tasks"] as Array<Record<string, unknown>>) : []).slice(0, COMPACT_TRACE_TASK_CAP).map((k) => ({
    taskId: str(k["taskId"] ?? k["id"], 120),
    resolverId: str(k["resolverId"] ?? k["resolver"], 120),
    outputShapes: Array.isArray(k["outputShapes"]) ? (k["outputShapes"] as unknown[]).map(String).slice(0, 12) : [],
    success: typeof k["success"] === "boolean" ? (k["success"] as boolean) : undefined,
  }));
  const c: CompactTrace = {
    id: t.id,
    templateId: str(x["templateId"], 200),
    templateName: str(x["templateName"], 200),
    compositionChain: Array.isArray(x["compositionChain"]) ? (x["compositionChain"] as unknown[]).map(String).slice(0, 32) : undefined,
    tasks,
    tags: (Array.isArray(x["tags"]) ? (x["tags"] as unknown[]).map(String) : []).filter((g) => !/^reached:/.test(g)).slice(0, COMPACT_TRACE_TAG_CAP),
  };
  if (JSON.stringify(c).length > COMPACT_TRACE_MAX_BYTES) { c.tasks = []; c.compositionChain = undefined; }
  return JSON.stringify(c).length > COMPACT_TRACE_MAX_BYTES ? null : c;
}

export type DeferralDecider = "person" | "judge-fallback";

/** The graded re-insert of a deferral's trace after its /reach matched no row. */
export function reinsertTraceForVerdict(c: CompactTrace, reached: boolean, decidedBy: DeferralDecider, betaWithheldReason: string | null | undefined): ExecutionTrace {
  let tags = [...c.tags, reached ? "reached:true" : "reached:false", `reinserted_from_deferral:${c.id}`, `decided_by:${decidedBy}`];
  if (decidedBy === "judge-fallback") tags = withBetaWithheld(tags, "judge-fallback: no person verdict");
  else if (betaWithheldReason) tags = withBetaWithheld(tags, betaWithheldReason);
  return {
    id: c.id,
    templateId: c.templateId,
    templateName: c.templateName,
    status: reached ? "completed" : "failed",
    ...(c.compositionChain ? { compositionChain: c.compositionChain } : {}),
    tasks: c.tasks,
    tags,
    metadata: { satisfier: true, reinserted_from_deferral: c.id, decided_by: decidedBy },
  } as unknown as ExecutionTrace;
}

/** Why a deferral must not open (nothing to patch), or null when it may. */
export function deferralOpenRefusal(executionId: string, syntheticPrefixes: readonly string[], compact: CompactTrace | null): string | null {
  if (syntheticPrefixes.some((p) => executionId.startsWith(p))) return `synthetic execution id (${executionId.slice(0, 40)}): no row to patch`;
  if (executionId.startsWith("walk-satisfier-") && !compact) return "satisfier reach whose durable trace was not persisted: no row to patch";
  return null;
}

/** Bounded: the durable traces this process persisted, by execution id, for the deferral opened right after. */
export class DurableTraceMemo {
  private m = new Map<string, CompactTrace>();
  constructor(private cap = 256) {}
  remember(t: ExecutionTrace | null | undefined): void {
    const c = compactDeferralTrace(t);
    if (!c) return;
    this.m.delete(c.id);
    this.m.set(c.id, c);
    while (this.m.size > this.cap) { const k = this.m.keys().next().value; if (k === undefined) break; this.m.delete(k); }
  }
  get(id: string): CompactTrace | null { return this.m.get(id) ?? null; }
}

/** One-shot repairs a /reach that matched no row runs, by execution id (registered by the deferral's decision). */
export class NoRowRepairs {
  private m = new Map<string, () => Promise<boolean>>();
  set(id: string, f: () => Promise<boolean>): void { this.m.set(id, f); if (this.m.size > 256) { const k = this.m.keys().next().value; if (k !== undefined) this.m.delete(k); } }
  take(id: string): (() => Promise<boolean>) | undefined { const f = this.m.get(id); this.m.delete(id); return f; }
}

/** An in-process retry (1/4/12 s) for a best-effort post that must not be dropped on one transport failure. */
export async function withRetry<T>(f: () => Promise<T>, ok: (v: T) => boolean, backoffMs: readonly number[] = [1_000, 4_000, 12_000], sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<{ value: T | null; attempts: number; error: string | null }> {
  let error: string | null = null;
  for (let a = 0; a <= backoffMs.length; a++) {
    if (a > 0) await sleep(backoffMs[a - 1]!);
    try { const v = await f(); if (ok(v)) return { value: v, attempts: a + 1, error: null }; error = "not ok"; }
    catch (e) { error = String((e as Error)?.message ?? e); }
  }
  return { value: null, attempts: backoffMs.length + 1, error };
}
