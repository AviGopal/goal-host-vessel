// JUDGE AND ROUTING INPUT CAPTURE (closed core, src/judge/).
//
// WHAT THIS IS. Every reach-path decision (the reach gate, the floor verdict, the floor shortcut, reframe
// acceptance, the beta decision on a hollow) and the edit-intent routing decision is recorded, at the
// moment it is made, as a replayable input record: exactly what the decision read, the LLM-judge verdict
// it consumed (as data), the ports it read (citation re-reads, write read-backs) and the decision it
// returned. A recorded run becomes a corpus case without re-running anything.
//
// WHERE IT GOES. Onto the dispatch's own record (`metadata.judge_input.<entry>` and
// `metadata.routing_input`), the same record GET /executions/:id serves (with ?include=metadata) and the
// dispatch store persists. Nothing here performs I/O: no fetch, no file read, no clock, no randomness,
// no env read. A capture is synchronous and runs AFTER the decision it records, from values the decision
// already computed, so it cannot change any decision.
//
// FAIL-OPEN FOR DELIVERY, NEVER SILENT. A capture that throws is caught here; the decision is delivered
// unchanged, the failure is counted (`capture_error`) and logged with its count. A capture outside a
// dispatch (no bound record) is counted as `unbound` and does nothing.
//
// SIZE. Two caps, both applied on every write. One record is capped at 32 KB serialized (the digest
// excerpt first, then the largest remaining strings, then long arrays). Then the dispatch's whole capture
// (every judge_input entry + routing_input) is capped at 16 KB: the largest free-text fields first
// (digest_excerpt, answer_text, goal, restated_goal), then any large string, then long arrays; schema and
// entry are never cut. Every cut carries a marker in the field, and the dispatch cap also records which
// fields it cut and the size before the cut (metadata.capture_truncated).
//
// SCHEMA. `schema: 1` for both families. The record shape is additive-only: a later field gets a
// documented neutral value for older records, never a default that changes a replayed decision.

import { AsyncLocalStorage } from "node:async_hooks";
import { isEditIntentGoal } from "../goal-intent";
import { isPathlessCodeChangeGoal } from "../goal-file-resolution";

export const JUDGE_INPUT_SCHEMA = 1;
export const ROUTING_INPUT_SCHEMA = 1;
/** The per-record cap, in bytes of the record's JSON serialization. */
export const CAPTURE_RECORD_CAP_BYTES = 32 * 1024;
/** The per-DISPATCH cap: every judge_input entry and the routing_input together, serialized. */
export const CAPTURE_DISPATCH_CAP_BYTES = 16 * 1024;
/** The per-read cap on a routing read's recorded text (characters); a cut read is marked and makes its record capped. */
export const CAPTURE_READ_CAP_CHARS = 4 * 1024;
/** Every truncated string or array carries this marker. */
export const CAPTURE_TRUNCATION_MARKER = "[judge-capture: truncated";

import type {
  CaptureTarget, CaptureTruncation, CreditOnHollowInput, FloorShortcutInput, FloorVerdictInput, JudgeCaptureMetadata, JudgeEntry,
  JudgeInputRecord, JudgeSurface, Json, RecordedLlmJudge, RecordedPorts, ReachGateInput, ReframeAcceptInput,
  RoutingEntry, RoutingInputRecord, RoutingResolution,
} from "./capture-records";
export type {
  CaptureTarget, CaptureTruncation, CreditOnHollowInput, FloorShortcutInput, FloorVerdictInput, JudgeCaptureMetadata, JudgeEntry,
  JudgeInputRecord, JudgeSurface, RecordedLlmJudge, RecordedPorts, ReachGateInput, ReframeAcceptInput,
  RoutingEntry, RoutingInputRecord, RoutingResolution,
};

// ── counters ────────────────────────────────────────────────────────────────────────────────────
const counters = { captured: 0, capture_error: 0, unbound: 0 };
export function captureCounters(): Readonly<typeof counters> { return { ...counters }; }
export function resetCaptureCounters(): void { counters.captured = 0; counters.capture_error = 0; counters.unbound = 0; }

function captureError(entry: string, e: unknown): void {
  counters.capture_error++;
  try {
    console.warn(`[judge-capture] capture_error #${counters.capture_error} entry=${entry} (the decision was delivered unchanged; this record is lost): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  } catch { /* the counter is the record of last resort */ }
}

// ── the bound dispatch ──────────────────────────────────────────────────────────────────────────
interface Pending { llm: RecordedLlmJudge; citation: RecordedPorts["citation"]; writeReadback: Record<string, boolean>; lastReachGate: JudgeInputRecord | null }
const targetStore = new AsyncLocalStorage<CaptureTarget>();
const pendingByTarget = new WeakMap<CaptureTarget, Pending>();

/** Run `fn` with `target` as the record every capture below it attaches to. Returns fn's own value (no added tick). */
export function withCaptureTarget<T>(target: CaptureTarget, fn: () => T): T {
  return targetStore.run(target, fn);
}
/** Bind `target` for the rest of the current async execution (the dispatch's own async body). */
export function bindCaptureTarget(target: CaptureTarget): void {
  try { targetStore.enterWith(target); } catch (e) { captureError("bind", e); }
}

function boundTarget(): CaptureTarget | undefined {
  const t = targetStore.getStore();
  if (!t) counters.unbound++;
  return t;
}

function pendingOf(t: CaptureTarget): Pending {
  let p = pendingByTarget.get(t);
  if (!p) {
    p = { llm: { consulted: false, judge: null }, citation: [], writeReadback: {}, lastReachGate: null };
    pendingByTarget.set(t, p);
  }
  return p;
}

// ── size cap ────────────────────────────────────────────────────────────────────────────────────
function byteLen(s: string): number { return Buffer.byteLength(s, "utf8"); }

function cutString(s: string, keepChars: number, capLabel: string = `${CAPTURE_RECORD_CAP_BYTES}-byte record`): string {
  const keep = Math.max(0, Math.min(s.length, keepChars));
  return `${s.slice(0, keep)}…${CAPTURE_TRUNCATION_MARKER} ${s.length - keep} of ${s.length} chars to fit the ${capLabel} cap]`;
}

/** Every string leaf, as [container, key, length]. */
function stringLeaves(v: unknown, out: Array<[Record<string, unknown> | unknown[], string | number, number]>): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => { if (typeof x === "string") out.push([v, i, x.length]); else stringLeaves(x, out); });
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "string") out.push([v as Record<string, unknown>, k, x.length]); else stringLeaves(x, out);
    }
  }
}
function arrays(v: unknown, out: unknown[][]): void {
  if (Array.isArray(v)) { out.push(v); v.forEach((x) => arrays(x, out)); }
  else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) arrays(x, out);
}

/** Cap a (JSON-clean) record to CAPTURE_RECORD_CAP_BYTES, in place. Returns true when it cut anything. */
export function capRecord(rec: Record<string, unknown>, cap: number = CAPTURE_RECORD_CAP_BYTES): boolean {
  let size = byteLen(JSON.stringify(rec));
  if (size <= cap) return false;
  const MARKER_ROOM = 160;
  // 1. The digest excerpt first: it is the largest field by design and the least load-bearing per byte.
  const input = rec["input"] as Record<string, unknown> | undefined;
  if (input && typeof input["digest_excerpt"] === "string" && (input["digest_excerpt"] as string).length > 512) {
    const d = input["digest_excerpt"] as string;
    input["digest_excerpt"] = cutString(d, Math.max(256, d.length - (size - cap) - MARKER_ROOM));
    size = byteLen(JSON.stringify(rec));
  }
  // 2. Then the largest remaining strings, one at a time.
  for (let guard = 0; size > cap && guard < 64; guard++) {
    const leaves: Array<[Record<string, unknown> | unknown[], string | number, number]> = [];
    stringLeaves(rec, leaves);
    leaves.sort((a, b) => b[2] - a[2]);
    const top = leaves[0];
    if (!top || top[2] <= 256) break;
    const [c, k, len] = top;
    const s = (c as Record<string | number, unknown>)[k] as string;
    if (s.includes(CAPTURE_TRUNCATION_MARKER) && len <= 512) break;
    (c as Record<string | number, unknown>)[k] = cutString(s, Math.max(128, len - (size - cap) - MARKER_ROOM));
    size = byteLen(JSON.stringify(rec));
  }
  // 3. Then long arrays, halving the longest each round.
  for (let guard = 0; size > cap && guard < 64; guard++) {
    const all: unknown[][] = [];
    arrays(rec, all);
    all.sort((a, b) => b.length - a.length);
    const top = all[0];
    if (!top || top.length <= 1) break;
    const n = top.length;
    const keep = Math.max(1, Math.floor(n / 2) - 1);
    top.splice(keep, n - keep, `${CAPTURE_TRUNCATION_MARKER} ${n - keep} of ${n} items to fit the ${CAPTURE_RECORD_CAP_BYTES}-byte record cap]`);
    size = byteLen(JSON.stringify(rec));
  }
  rec["capped"] = true;
  return true;
}

/** Free-text fields cut first under the dispatch cap, in this order of preference (largest first among them). */
const DISPATCH_CUT_FIRST = new Set(["digest_excerpt", "answer_text", "goal", "restated_goal"]);
/** Keys never cut: what makes a record a record. */
const NEVER_CUT = new Set(["schema", "entry"]);

/** Every string leaf under `v`, with its dotted path. */
function pathedLeaves(v: unknown, path: string, out: Array<{ c: Record<string | number, unknown>; k: string | number; path: string; key: string; len: number }>): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => { if (typeof x === "string") out.push({ c: v as unknown as Record<number, unknown>, k: i, path: `${path}[${i}]`, key: "", len: x.length }); else pathedLeaves(x, `${path}[${i}]`, out); });
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof x === "string") out.push({ c: v as Record<string, unknown>, k, path: p, key: k, len: x.length }); else pathedLeaves(x, p, out);
    }
  }
}

/**
 * Cap a dispatch's whole capture (all judge_input entries + routing_input) to CAPTURE_DISPATCH_CAP_BYTES, in place.
 * Runs after the per-record cap, on every write. Cuts the largest free-text fields first (digest_excerpt, answer_text,
 * goal, restated_goal), then the largest remaining strings, then long arrays; never the schema/entry keys. Every cut is
 * marked in the field and listed in metadata.capture_truncated with the size before the cut. Returns true when it cut.
 */
export function capDispatchTotal(meta: JudgeCaptureMetadata, cap: number = CAPTURE_DISPATCH_CAP_BYTES): boolean {
  const prior = meta.capture_truncated;
  const body = (): Record<string, unknown> => ({ judge_input: meta.judge_input, routing_input: meta.routing_input });
  let size = byteLen(JSON.stringify(body()));
  if (size <= cap) return false;
  const original = Math.max(size, prior?.original_bytes ?? 0);
  const truncated = new Set(prior?.truncated ?? []);
  const label = `${cap}-byte dispatch`;
  const MARKER_ROOM = 160;
  const cutLargest = (pick: (l: { key: string; len: number }) => boolean, floor: number): boolean => {
    const leaves: Parameters<typeof pathedLeaves>[2] = [];
    pathedLeaves(body(), "", leaves);
    const cands = leaves.filter((l) => !NEVER_CUT.has(l.key) && pick(l) && l.len > floor).sort((a, b) => b.len - a.len);
    const top = cands[0];
    if (!top) return false;
    const s = top.c[top.k] as string;
    if (s.includes(CAPTURE_TRUNCATION_MARKER) && top.len <= floor + 256) return false;
    top.c[top.k] = cutString(s, Math.max(floor, top.len - (size - cap) - MARKER_ROOM), label);
    truncated.add(top.path);
    size = byteLen(JSON.stringify(body()));
    return true;
  };
  for (let g = 0; size > cap && g < 64 && cutLargest((l) => DISPATCH_CUT_FIRST.has(l.key), 128); g++) { /* free text first */ }
  for (let g = 0; size > cap && g < 128 && cutLargest(() => true, 128); g++) { /* then any large string */ }
  for (let g = 0; size > cap && g < 64; g++) {
    const all: unknown[][] = [];
    arrays(body(), all);
    all.sort((a, b) => b.length - a.length);
    const top = all[0];
    if (!top || top.length <= 1) break;
    const n = top.length;
    const keep = Math.max(1, Math.floor(n / 2) - 1);
    top.splice(keep, n - keep, `${CAPTURE_TRUNCATION_MARKER} ${n - keep} of ${n} items to fit the ${label} cap]`);
    truncated.add(`(an array of ${n} items)`);
    size = byteLen(JSON.stringify(body()));
  }
  const marker: CaptureTruncation = { cap_bytes: cap, original_bytes: original, final_bytes: size, truncated: [...truncated] };
  // A routing record with any cut field cannot be replayed as recorded: say so on the record itself.
  if (meta.routing_input && [...truncated].some((p) => p.startsWith("routing_input") || p.startsWith("(an array"))) meta.routing_input.capped = true;
  meta.capture_truncated = marker;
  return true;
}

// The copy is typed by the field it is written into (the record interfaces in capture-records.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clean(v: unknown): any {
  // A deep, JSON-clean copy: the record never aliases live walk state. Throws on a cycle or a BigInt,
  // which the callers below turn into a counted capture_error.
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}
const excerpt = (s: string | null | undefined): string | null => (typeof s === "string" ? s : null);

// ── entry builders (the documented input of each entry) ─────────────────────────────────────────
export interface ReachGateCaptureArgs {
  goal: string;
  originalTargets: readonly string[] | null;
  deliverables: readonly string[] | null;
  targetsSeenByWalk: readonly string[] | null;
  reframedFrom: readonly string[] | null;
  persistedWrites: readonly string[] | null;
  landed: boolean | null;
  landedEffective: boolean | null;
  producedShapes: readonly string[];
  postReachSink: boolean | null;
  toolsTotal: number | null;
  groundedReads: number | null;
  outputImpulses: number | null;
  consumedInChain: number | null;
  surface: JudgeSurface | null;
  digest: string | null;
  taskSummary: string | null;
  commandEvidence: string | null;
  walkEvidence: { gapsFiled: number; walkLog: readonly string[] } | null;
  judgeView: { deliverableCut: boolean; cuts: unknown } | null;
}
/** reachGate input: {goal, original_targets, deliverables, targets_seen_by_walk, reframed_from, evidence{…}, surface, digest_excerpt, gate_context{…}}. */
export function reachGateInput(a: ReachGateCaptureArgs): ReachGateInput {
  return {
    goal: a.goal,
    original_targets: clean(a.originalTargets),
    deliverables: clean(a.deliverables),
    targets_seen_by_walk: clean(a.targetsSeenByWalk),
    reframed_from: clean(a.reframedFrom),
    evidence: {
      persisted_writes: clean(a.persistedWrites),
      landed: a.landed,
      landed_effective: a.landedEffective,
      produced_shapes: clean(a.producedShapes),
      post_reach_sink: a.postReachSink,
      tools_total: a.toolsTotal,
      grounded_reads: a.groundedReads,
      output_impulses: a.outputImpulses,
      consumed_in_chain: a.consumedInChain,
    },
    surface: a.surface,
    digest_excerpt: excerpt(a.digest),
    gate_context: {
      task_summary: excerpt(a.taskSummary),
      command_evidence: excerpt(a.commandEvidence),
      walk_gaps_filed: a.walkEvidence ? a.walkEvidence.gapsFiled : null,
      walk_step_lines: a.walkEvidence ? a.walkEvidence.walkLog.filter((l) => /\bstep \d+ ran /.test(l)) : null,
      judge_view: a.judgeView ? clean({ deliverable_cut: a.judgeView.deliverableCut, cuts: a.judgeView.cuts }) : null,
    },
  };
}

export interface FloorVerdictCaptureArgs extends ReachGateCaptureArgs {
  answerText: string;
  verdictReason: string | null;
  seededEvidence: boolean;
  toolsOk: number;
  authoredAnswer: boolean;
}
/** floorVerdict input: the reachGate input plus {answer_text, verdict_reason, seeded_evidence, tools_ok, authored_answer}. */
export function floorVerdictInput(a: FloorVerdictCaptureArgs): FloorVerdictInput {
  return {
    ...reachGateInput(a),
    answer_text: a.answerText,
    verdict_reason: a.verdictReason,
    seeded_evidence: a.seededEvidence,
    tools_ok: a.toolsOk,
    authored_answer: a.authoredAnswer,
  };
}

/** floorShortcut input: {goal, activities[], borrowed, targets}. */
export function floorShortcutInput(a: { goal: string; activities: readonly string[]; borrowed: boolean; targets: readonly string[] }): FloorShortcutInput {
  return { goal: a.goal, activities: clean(a.activities), borrowed: a.borrowed, targets: clean(a.targets) };
}

/** reframeAccept input: {goal, original_targets, alternatives[], alt_targets, alt_walk{…}, orig_wanted_derived, planned_retrieval}. */
export function reframeAcceptInput(a: {
  goal: string;
  originalTargets: readonly string[];
  alternatives: readonly (readonly string[])[];
  altTargets: readonly string[];
  altWalk: { reached: boolean | null; abstain: boolean; produced: readonly string[]; substantiveShapes: readonly string[]; onlyRawInput: boolean; skippedPlannedRetrieval: boolean };
  origWantedDerived: boolean;
  plannedRetrieval: readonly string[];
}): ReframeAcceptInput {
  return {
    goal: a.goal,
    original_targets: clean(a.originalTargets),
    alternatives: clean(a.alternatives),
    alt_targets: clean(a.altTargets),
    alt_walk: {
      reached: a.altWalk.reached,
      abstain: a.altWalk.abstain,
      produced: clean(a.altWalk.produced),
      substantive_shapes: clean(a.altWalk.substantiveShapes),
      only_raw_input: a.altWalk.onlyRawInput,
      skipped_planned_retrieval: a.altWalk.skippedPlannedRetrieval,
    },
    orig_wanted_derived: a.origWantedDerived,
    planned_retrieval: clean(a.plannedRetrieval),
  };
}

/** The reason code a verdict reason leads with (`deterministic:…`, `abstain:…`), else null. */
export function reasonCodeOf(reason: string | null | undefined): string | null {
  const m = /^(?:\[human override:[^\]]*\]\s*)?((?:deterministic|abstain|floor|hollow)[:\w.-]*)/i.exec(String(reason ?? ""));
  return m ? m[1]! : null;
}
/** The class of an arm id: a satisfier pseudo-id, the floor, or a template. */
export function templateIdClassOf(id: string): "satisfier" | "floor" | "template" {
  if (id.startsWith("satisfier:")) return "satisfier";
  if (id === "universal-tool-fallback") return "floor";
  return "template";
}
/**
 * creditOnHollow input: {template_id_class, template_id, verdict{deterministic, hollow_class}, consumed_in_chain,
 * edit_effect_reach, last_pick_produced_judged_artifact, no_oracle, history}. `history` (the template's K most recent
 * attempts) needs a trace-store read, which capture never performs: it is null until the closed core reads it.
 */
export function creditOnHollowInput(a: {
  templateId: string;
  verdict: { deterministic: boolean; reason: string | null };
  consumedInChain: number;
  editEffectReach: boolean | null;
  lastPickProducedJudgedArtifact: boolean;
  noOracle: boolean;
}): CreditOnHollowInput {
  return {
    template_id_class: templateIdClassOf(a.templateId),
    template_id: a.templateId,
    verdict: { deterministic: a.verdict.deterministic, hollow_class: reasonCodeOf(a.verdict.reason) },
    consumed_in_chain: a.consumedInChain,
    edit_effect_reach: a.editEffectReach,
    last_pick_produced_judged_artifact: a.lastPickProducedJudgedArtifact,
    no_oracle: a.noOracle,
    history: null,
  };
}

// ── judge capture ───────────────────────────────────────────────────────────────────────────────
// A reach gate's LLM verdict and citation reads are pending until its capture consumes them; the capture then
// forgets them, so the next gate starts clean. Write read-backs accumulate over the walk.

/** The LLM judge was consulted and returned `v` (null: no verdict). */
export function noteLlmJudge(v: { reached?: unknown; reason?: unknown; deterministic?: unknown } | null | undefined): void {
  try {
    const t = targetStore.getStore();
    if (!t) return;
    pendingOf(t).llm = {
      consulted: true,
      judge: v ? { reached: v.reached === true, reason: typeof v.reason === "string" ? v.reason : null, deterministic: v.deterministic === true } : null,
    };
  } catch (e) { captureError("reachGate", e); }
}

/** The citation oracle re-read one cited location (`lines` null: it did not re-read at any root). */
export function noteCitationPort(c: { path: string; line: number | null; at: string | null; lines: readonly string[] | null; symbols: readonly string[] }): void {
  try {
    const t = targetStore.getStore();
    if (!t) return;
    const contains = c.lines ? Object.fromEntries(c.symbols.map((s) => [s, c.lines!.some((l) => l.includes(s))])) : null;
    const windowLines = c.lines && c.line !== null && c.line >= 1 && c.line <= c.lines.length ? c.lines.slice(Math.max(0, c.line - 3), c.line + 2) : null;
    const lineWindow = windowLines ? Object.fromEntries(c.symbols.map((s) => [s, windowLines.some((l) => l.includes(s))])) : null;
    pendingOf(t).citation.push({ path: c.path, line: c.line, read_at: c.at, contains, line_window_contains: lineWindow });
  } catch (e) { captureError("reachGate", e); }
}

/** Observe a write read-back without changing it: returns the SAME promise, records on a side branch. */
export function observeWriteReadback<T extends { persisted: boolean } | null>(shape: string, p: Promise<T>): Promise<T> {
  try {
    const t = targetStore.getStore();
    if (t) {
      p.then((r) => {
        try { if (r !== null) pendingOf(t).writeReadback[shape] = r.persisted === true; } catch (e) { captureError("reachGate", e); }
      }, () => { /* the caller sees the rejection; nothing to record */ });
    }
  } catch (e) { captureError("reachGate", e); }
  return p;
}

/**
 * Record one decision. `input` is the entry's documented input (the builders above); `verdict` is what the decision
 * returned. The LLM verdict and ports are the ones recorded since the previous reach gate's capture (reachGate), or
 * the ones of the reach gate this decision consumed (floorVerdict). Never throws.
 */
export function captureJudgeInput(entry: JudgeEntry, input: () => object, verdict: unknown): void {
  const t = targetStore.getStore();
  try {
    if (!t) { counters.unbound++; return; }
    const p = pendingOf(t);
    const prior = t.metadata?.judge_input?.[entry];
    const llm: RecordedLlmJudge = entry === "reachGate" ? p.llm : entry === "floorVerdict" && p.lastReachGate ? p.lastReachGate.llm : { consulted: false, judge: null };
    const citation = entry === "reachGate" ? p.citation : entry === "floorVerdict" && p.lastReachGate ? p.lastReachGate.ports.citation : [];
    const rec: JudgeInputRecord = {
      schema: JUDGE_INPUT_SCHEMA,
      entry,
      input: input() as Record<string, Json>,
      llm: clean(llm) as unknown as RecordedLlmJudge,
      ports: { citation: clean(citation) as unknown as RecordedPorts["citation"], write_readback: { ...p.writeReadback } },
      verdict: clean(verdict),
      calls: (prior?.calls ?? 0) + 1,
    };
    capRecord(rec as unknown as Record<string, unknown>);
    t.metadata ??= {};
    t.metadata.judge_input ??= {};
    t.metadata.judge_input[entry] = rec;
    capDispatchTotal(t.metadata);
    if (entry === "reachGate") p.lastReachGate = rec;
    counters.captured++;
  } catch (e) {
    captureError(entry, e);
  } finally {
    if (entry === "reachGate" && t) {
      try { const p = pendingOf(t); p.llm = { consulted: false, judge: null }; p.citation = []; } catch { /* nothing pending to forget */ }
    }
  }
}

// ── routing capture ─────────────────────────────────────────────────────────────────────────────
type Search = (term: string, vessel?: string, preferCallSites?: boolean) => Promise<readonly string[]>;

/** Records what the pathless resolution searched, found and read, by wrapping the callbacks it is handed. */
export interface RoutingRecorder {
  search(fn: Search): Search;
  symbolSearch(fn: Search): Search;
  propose(fn: (goal: string) => Promise<readonly string[]>): (goal: string) => Promise<readonly string[]>;
  read(fn: (path: string) => Promise<string | undefined>): (path: string) => Promise<string | undefined>;
  tap(fn: (message: string) => void): (message: string) => void;
  /** The routing_input record for the door's decision (null when capture failed; counted). */
  finish(rawGoal: string, resolvedGoal: string): RoutingInputRecord | null;
}

const RESTATED = /restated with target (\S+) \((.*)$/;
/** The resolution method, from the resolver's own decision line. */
export function resolutionMethodOf(line: string): string {
  const why = RESTATED.exec(line)?.[2] ?? "";
  if (/^unique hit for/.test(why)) return "unique-term-hit";
  if (/goal asks callers to USE/.test(why)) return "adopt-call-site";
  if (/^symbol declaring/.test(why)) return "symbol-declaration";
  if (/^declares symbols for/.test(why)) return "symbol-corroboration";
  if (/^proposed symbol "/.test(why)) return "proposed-symbol";
  if (/was ambiguous across/.test(why)) return "proposed-symbol-narrowed";
  if (/proposed symbols; strict leader/.test(why)) return "proposed-symbol-corroboration";
  return "other";
}

export function routingRecorder(): RoutingRecorder {
  const terms: string[] = [];
  const candidates: RoutingResolution["candidates"] = [];
  const reads: RoutingResolution["reads"] = [];
  const trail: string[] = [];
  let failed = false;
  const safe = (f: () => void): void => { try { f(); } catch (e) { if (!failed) { failed = true; captureError("editIntent", e); } } };
  const noteTerm = (t: string): void => { if (!terms.includes(t)) terms.push(t); };
  const wrapSearch = (via: "term" | "symbol", fn: Search): Search => (term, vessel, preferCallSites) => {
    const p = fn(term, vessel, preferCallSites);
    safe(() => {
      noteTerm(term);
      p.then(
        (hits) => safe(() => { candidates.push({ via, term, scope: vessel ?? null, prefer_call_sites: via === "term" ? preferCallSites === true : null, hits: [...hits], error: false }); }),
        () => safe(() => { candidates.push({ via, term, scope: vessel ?? null, prefer_call_sites: via === "term" ? preferCallSites === true : null, hits: null, error: true }); }),
      );
    });
    return p;
  };
  return {
    search: (fn) => wrapSearch("term", fn),
    symbolSearch: (fn) => wrapSearch("symbol", fn),
    propose: (fn) => (g) => {
      const p = fn(g);
      safe(() => {
        p.then(
          (words) => safe(() => { candidates.push({ via: "proposal", term: "(proposed symbols)", scope: null, prefer_call_sites: null, hits: [...words], error: false }); }),
          () => safe(() => { candidates.push({ via: "proposal", term: "(proposed symbols)", scope: null, prefer_call_sites: null, hits: null, error: true }); }),
        );
      });
      return p;
    },
    read: (fn) => (path) => {
      const p = fn(path);
      safe(() => {
        p.then(
          (txt) => safe(() => {
            if (typeof txt !== "string") { reads.push({ path, readable: false, text: null }); return; }
            if (txt.length > CAPTURE_READ_CAP_CHARS) reads.push({ path, readable: true, text: cutString(txt, CAPTURE_READ_CAP_CHARS, `${CAPTURE_READ_CAP_CHARS}-char read`), capped: true });
            else reads.push({ path, readable: true, text: txt });
          }),
          () => safe(() => { reads.push({ path, readable: false, text: null }); }),
        );
      });
      return p;
    },
    tap: (fn) => (message) => {
      safe(() => { trail.push(message); });
      fn(message);
    },
    finish(rawGoal, resolvedGoal) {
      try {
        const pathless = isPathlessCodeChangeGoal(rawGoal);
        const chosenLine = [...trail].reverse().find((l) => RESTATED.test(l));
        const restated = resolvedGoal !== rawGoal;
        const chosen = restated && chosenLine ? RESTATED.exec(chosenLine)![1]! : null;
        const method = !pathless
          ? "not-pathless"
          : restated
            ? (chosenLine ? resolutionMethodOf(chosenLine) : "other")
            : trail.some((l) => /threw/.test(l)) ? "search-error" : "unresolved";
        const rec: RoutingInputRecord = {
          schema: ROUTING_INPUT_SCHEMA,
          entry: "editIntent",
          goal: rawGoal,
          is_edit_intent: isEditIntentGoal(resolvedGoal),
          is_pathless_code_change: pathless,
          resolution: { terms: [...terms], candidates: clean(candidates) as unknown as RoutingResolution["candidates"], chosen_file: chosen, method, reads: [...reads] },
          restated_goal: restated ? resolvedGoal : null,
          compose_gap_id: null,
          routed_to: "walk",
          route_enabled: null,
          localization: null,
          edit_site: null,
          gap_hint: null,
          trail: trail.slice(0, 40),
        };
        if (reads.some((r) => r.capped === true)) rec.capped = true;
        capRecord(rec as unknown as Record<string, unknown>);
        counters.captured++;
        return rec;
      } catch (e) {
        captureError("editIntent", e);
        return null;
      }
    },
  };
}

/** Attach the door's routing record to the dispatch record it belongs to. */
export function attachRoutingInput(target: CaptureTarget, rec: RoutingInputRecord | null | undefined): void {
  try {
    if (!rec) return;
    target.metadata ??= {};
    target.metadata.routing_input = rec;
    capDispatchTotal(target.metadata);
  } catch (e) { captureError("editIntent", e); }
}

/** The bound record's routing_input, created complete (method not-captured-at-door) when the door recorded none. */
function routingInputOf(t: CaptureTarget, goal: string): RoutingInputRecord {
  t.metadata ??= {};
  let rec = t.metadata.routing_input;
  if (!rec) {
    rec = {
      schema: ROUTING_INPUT_SCHEMA,
      entry: "editIntent",
      goal,
      is_edit_intent: isEditIntentGoal(goal),
      is_pathless_code_change: isPathlessCodeChangeGoal(goal),
      resolution: { terms: [], candidates: [], chosen_file: null, method: "not-captured-at-door", reads: [] },
      restated_goal: null,
      compose_gap_id: null,
      routed_to: "walk",
      route_enabled: null,
      localization: null,
      edit_site: null,
      gap_hint: null,
      trail: [],
    };
    t.metadata.routing_input = rec;
  }
  return rec;
}

/** The walk hydrated a gap record named by the goal; `applied` = its cited file was put on the routing goal. */
export function noteGapHydration(h: { goal: string; gapId: string; citedFile: string | null; applied: boolean; summary: string }): void {
  try {
    const t = boundTarget();
    if (!t) return;
    const rec = routingInputOf(t, h.goal);
    rec.gap_hint = { gap_id: h.gapId, cited_file: h.citedFile, applied: h.applied, summary: h.applied ? h.summary : null };
    capRecord(rec as unknown as Record<string, unknown>);
    capDispatchTotal(t.metadata!);
    counters.captured++;
  } catch (e) { captureError("editIntent", e); }
}

/** The early edit-intent check read its route switch (the in-process value it decided with; no new read). */
export function noteRouteEnabled(h: { goal: string; enabled: boolean }): void {
  try {
    const t = boundTarget();
    if (!t) return;
    routingInputOf(t, h.goal).route_enabled = h.enabled;
    counters.captured++;
  } catch (e) { captureError("editIntent", e); }
}

/** The edit-intent route handed this dispatch to the compose producer. */
export function noteRoutingHandOff(h: { goal: string; composeGapId: string; editSite: string }): void {
  try {
    const t = boundTarget();
    if (!t) return;
    const rec = routingInputOf(t, h.goal);
    rec.compose_gap_id = h.composeGapId;
    rec.routed_to = "feature_compose";
    rec.edit_site = h.editSite;
    capRecord(rec as unknown as Record<string, unknown>);
    capDispatchTotal(t.metadata!);
    counters.captured++;
  } catch (e) { captureError("editIntent", e); }
}
