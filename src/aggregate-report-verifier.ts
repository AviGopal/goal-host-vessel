/**
 * AGGREGATE-REPORT FAITHFULNESS — a structured report checked section by section against the
 * authoritative store it claims to summarise.
 *
 * MEASURED: a recurring report goal reaches at step 1 and the LLM judge passes it, yet the α gate
 * withholds credit ("no in-chain producer-to-consumer edge and no landed sha") because nothing
 * deterministic ever graded the class. The report is STRUCTURED: each section embeds the very
 * aggregate response its producer read (rows of {key, value} plus the store's own truncated /
 * total_groups), so the check needs no parse of prose — re-read the same source with the same
 * pointer and compare the rows by key.
 *
 * What this is and is not, stated in every verdict: the producer and this check read the SAME
 * authoritative resolver, so a pass is FAITHFULNESS (the report carries what the store says, nothing
 * dropped, nothing invented, within a relative drift for rows that move between the two reads), not
 * an independent recount.
 *
 * WHICH REPORTS: a report CLASS is data, not code — one row per class (the produced target shape, its
 * sections, each section's authoritative source and pointer, the drift, the required fields), read at
 * use time from the pool (law 1), so adding a class is a row write the system can make (law 2).
 *
 * OBSERVE ONLY. This module never decides a reach. Its verdict is compared with the judge's and the
 * comparison is recorded (the promotion evidence). Deciding is a separate step that must be honoured
 * only from a row the system cannot write for itself: the class row decides which reaches would earn
 * deterministic credit, so a self-written row would let the system mint its own credit.
 *
 * Abstains (null, with a named reason) rather than guess: no class row for the target; no produced
 * impulse of the target shape; the source unreachable or unparseable; the source not stating
 * `truncated` and `total_groups` (absent is not false); a produced row the source's ordered, truncated
 * read cannot confirm; a field named in `abstain_when_true` set.
 */

/** The pool shape of a report-class row (one open row per class). */
export const REPORT_CLASS_SHAPE = "aggregateReportClass";

/** One section of a report class: where it sits in the produced report and what it must match. */
export interface ReportSection {
  /** Dotted path of the section in the produced report's content (a JSON string or an object). */
  field: string;
  /** The authoritative read: the shape to resolve and the pointer fields to send. */
  source: { shape: string; pointer: Record<string, unknown> };
  /** The produced section's first `top_n` rows are each checked against the source by key. */
  top_n: number;
  /** Allowed relative drift between the two reads: |produced − source| / max(1, source). */
  rel_drift: number;
}

/** One report class. */
export interface ReportClass {
  target_shape: string;
  sections: ReportSection[];
  /** Dotted paths that must be present (non-null) in the produced content: COMPLETENESS. */
  required_fields: string[];
  /** Dotted paths that, when `true` in the produced content, make the check abstain (e.g. a degraded scan). */
  abstain_when_true: string[];
}

export interface AggregateReportVerdict {
  reached: boolean;
  reason: string;
}

export interface RowsView {
  rows: Array<{ key: string; value: number }>;
  truncated?: boolean;
  total_groups?: number;
}

/** Parse a value that may be a JSON string; anything unparseable comes back unchanged. */
export function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try { return JSON.parse(t); } catch { return v; }
}

/** Read a dotted path, parsing JSON strings met on the way. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = parseMaybeJson(obj);
  for (const part of path.split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = parseMaybeJson((cur as Record<string, unknown>)[part]);
  }
  return cur;
}

/** A section or source response as rows; null when it carries no usable rows array. */
export function rowsOf(v: unknown): RowsView | null {
  const o = parseMaybeJson(v);
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  // A resolver envelope ({content}/{body}) is unwrapped once.
  const inner = !Array.isArray(r["rows"]) && (r["content"] ?? r["body"]) !== undefined ? parseMaybeJson(r["content"] ?? r["body"]) : r;
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return null;
  const x = inner as Record<string, unknown>;
  if (!Array.isArray(x["rows"])) return null;
  const rows: Array<{ key: string; value: number }> = [];
  for (const row of x["rows"] as unknown[]) {
    if (row === null || typeof row !== "object") return null;
    const k = (row as Record<string, unknown>)["key"];
    const val = Number((row as Record<string, unknown>)["value"]);
    if (typeof k !== "string" || !Number.isFinite(val)) return null;
    rows.push({ key: k, value: val });
  }
  return {
    rows,
    ...(typeof x["truncated"] === "boolean" ? { truncated: x["truncated"] as boolean } : {}),
    ...(typeof x["total_groups"] === "number" ? { total_groups: x["total_groups"] as number } : {}),
  };
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
}

/** A class row as stored, validated; null when it is not usable (a malformed row abstains, never half-applies). */
export function reportClassFrom(v: unknown): ReportClass | null {
  const o = parseMaybeJson(v);
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r["target_shape"] !== "string" || !r["target_shape"]) return null;
  if (!Array.isArray(r["sections"]) || r["sections"].length === 0) return null;
  const sections: ReportSection[] = [];
  for (const s of r["sections"] as unknown[]) {
    if (s === null || typeof s !== "object") return null;
    const x = s as Record<string, unknown>;
    const src = x["source"] as Record<string, unknown> | undefined;
    const topN = Number(x["top_n"]);
    const drift = Number(x["rel_drift"]);
    if (typeof x["field"] !== "string" || !x["field"]) return null;
    if (!src || typeof src["shape"] !== "string" || !src["shape"] || src["pointer"] === null || typeof src["pointer"] !== "object" || Array.isArray(src["pointer"])) return null;
    if (!Number.isInteger(topN) || topN < 1 || !(drift >= 0 && drift < 1)) return null;
    sections.push({ field: x["field"], source: { shape: src["shape"], pointer: src["pointer"] as Record<string, unknown> }, top_n: topN, rel_drift: drift });
  }
  return { target_shape: r["target_shape"], sections, required_fields: strList(r["required_fields"]), abstain_when_true: strList(r["abstain_when_true"]) };
}

/** The class row for any of the walk's target shapes, from the open rows' bodies; null when none matches. */
export function reportClassForTargets(rowBodies: readonly unknown[], targetShapes: readonly string[]): ReportClass | null {
  for (const b of rowBodies) {
    const c = reportClassFrom(b);
    if (c && targetShapes.includes(c.target_shape)) return c;
  }
  return null;
}

/** The produced report's content: the latest pool impulse of the target shape, unwrapped from an {emitted, content} envelope. */
export function producedContentOf(pool: ReadonlyArray<{ shape: string; content: unknown }>, targetShape: string): unknown {
  for (let i = pool.length - 1; i >= 0; i--) {
    const p = pool[i]!;
    if (p.shape !== targetShape) continue;
    const c = parseMaybeJson(p.content);
    if (c !== null && typeof c === "object" && !Array.isArray(c) && (c as Record<string, unknown>)["emitted"] === targetShape && "content" in (c as Record<string, unknown>)) {
      return parseMaybeJson((c as Record<string, unknown>)["content"]);
    }
    return c;
  }
  return undefined;
}

export interface AggregateReportInput {
  cls: ReportClass;
  /** The produced report's content (producedContentOf). */
  produced: unknown;
  /** Resolve the section's authoritative source; null when it could not be read. */
  fetchSource: (shape: string, pointer: Record<string, unknown>) => Promise<unknown>;
  onAbstain?: (why: string) => void;
}

const FAITHFULNESS = "same source as the producer (faithfulness, not an independent recount)";

/** Check a produced report against its class. Reached / not reached, or null (abstain) with a named reason. */
export async function verifyAggregateReport(input: AggregateReportInput): Promise<AggregateReportVerdict | null> {
  const { cls, produced } = input;
  const abstain = (why: string): null => { input.onAbstain?.(why); return null; };
  if (produced === undefined || produced === null) return abstain(`no produced ${cls.target_shape} impulse in the pool`);
  for (const f of cls.abstain_when_true) {
    if (getPath(produced, f) === true) return abstain(`${f} is true in the produced report`);
  }
  // COMPLETENESS of the named fields.
  const missing = cls.required_fields.filter((f) => { const v = getPath(produced, f); return v === undefined || v === null; });
  if (missing.length > 0) return { reached: false, reason: `deterministic:report-incomplete — the produced ${cls.target_shape} lacks ${missing.join(", ")}` };
  const checked: string[] = [];
  for (const s of cls.sections) {
    const mine = rowsOf(getPath(produced, s.field));
    if (!mine) return { reached: false, reason: `deterministic:report-incomplete — section ${s.field} carries no rows` };
    let raw: unknown;
    try { raw = await input.fetchSource(s.source.shape, s.source.pointer); } catch (e) { return abstain(`source ${s.source.shape} errored: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
    if (raw === null || raw === undefined) return abstain(`source ${s.source.shape} could not be read`);
    const truth = rowsOf(raw);
    if (!truth) return abstain(`source ${s.source.shape} answered without a rows array`);
    if (truth.truncated === undefined || truth.total_groups === undefined) return abstain(`source ${s.source.shape} does not state truncated/total_groups, so a missing row cannot be told from a cut one`);
    // COMPLETENESS of the section: as many rows as asked for, or every group when the store has fewer.
    const need = Math.min(s.top_n, truth.total_groups);
    if (mine.rows.length < need) return { reached: false, reason: `deterministic:report-incomplete — section ${s.field} has ${mine.rows.length} rows, the store has ${truth.total_groups} groups and the class asks for ${s.top_n}` };
    const byKey = new Map(truth.rows.map((r) => [r.key, r.value]));
    for (const row of mine.rows.slice(0, s.top_n)) {
      const v = byKey.get(row.key);
      if (v === undefined) {
        if (truth.truncated) return abstain(`section ${s.field} row ${row.key} is not in the store's truncated read`);
        return { reached: false, reason: `deterministic:report-unfaithful — section ${s.field} row ${row.key} does not exist in ${s.source.shape}; ${FAITHFULNESS}` };
      }
      const drift = Math.abs(row.value - v) / Math.max(1, v);
      if (drift > s.rel_drift) return { reached: false, reason: `deterministic:report-unfaithful — section ${s.field} row ${row.key}: report ${row.value}, store ${v} (drift ${(drift * 100).toFixed(2)}% > ${(s.rel_drift * 100).toFixed(2)}%); ${FAITHFULNESS}` };
    }
    checked.push(`${s.field} (${Math.min(s.top_n, mine.rows.length)} rows ≤ ${(s.rel_drift * 100).toFixed(2)}% drift)`);
  }
  return { reached: true, reason: `deterministic:report-faithful — ${checked.join("; ")}${cls.required_fields.length ? `; required fields present: ${cls.required_fields.join(", ")}` : ""}; ${FAITHFULNESS}` };
}
