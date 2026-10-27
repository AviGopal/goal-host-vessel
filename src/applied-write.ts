/**
 * THE WALK'S APPLIED *_write EFFECTS, OUT OF index.ts SO THEY CAN BE TESTED.
 *
 * Gap a-substrategap-write-satisfier-can-close-or-re-source-an-existing-gap-with-no-verdict.
 * A walk can APPLY a store-mutating `_write` (substrateGap_write, memoryNote_write,
 * concept_create_write, obsidian:write_note) from several sites: the satisfier's direct resolve,
 * its transient retry, the arg-correction re-resolve, the action-then-read action / retry /
 * re-read, the vessel-resolver producer scan (which re-enters the satisfier), and the post-reach
 * bridge sinks. Before this module only the result of a satisfier that RETURNED content was ever
 * traced durably, and a terminal write that verified persisted fell through and returned nothing,
 * so the write that actually changed the store left no durable record and the walk went on to
 * apply it again.
 *
 * Two pieces live here:
 *   - `settleVerifiedWrite`: the decision taken after `verifyWritePersisted` reads a write back,
 *     moved from the satisfier in index.ts (index.ts keeps the logging and the returns). A
 *     terminal write that reads back persisted now ends the attempt instead of falling through.
 *   - `createAppliedWriteLedger`: one per walk. Every applied write records through it, and the
 *     retry sites ask it whether a terminal write already verified in this walk may be applied
 *     again.
 *   - WRITE TASKS (findings agf_9oaufozk7r2a / agf_tqqcuevvt8o7, "trace ≠ effect"): every write the walk
 *     sent, accepted or refused, is also kept as a task of the satisfier step that sent it, and a read-back
 *     that confirmed it names that task. Before, the satellite record was the effect's only trace: the
 *     step's own trace showed a read, and the mint gate found no executed-tool anchor for a real change.
 */
import { redactResolvedConfig, type ExecutionTrace } from "@avigopal/ias-executor-ts";
import { isStoreWriteShape, stripEndpointOverrides, stripOperatorMarker } from "./resolve-pointer";
import { storeFamilyOf } from "./reach-grounding";
import { stepContentDigest, withBetaWithheld, type StepContentDigest } from "./satisfier-durable-trace";
import { WALK_MECHANICS_WRITES } from "./write-door";

/** A shape whose resolve MUTATES a store (resolve-pointer.ts isStoreWriteShape). */
export const isAppliedWriteShape = isStoreWriteShape;

export type WriteVerification = { persisted: true; content: unknown } | { persisted: false } | null;

/** What the satisfier does after the read-back:
 *  - `empty_terminal`: a terminal write persisted with an EMPTY body; not a genuine emit, fall through.
 *  - `terminal_persisted`: a terminal write read back persisted.
 *  - `persisted`: a non-terminal write read back persisted; return the read-back content.
 *  - `not_persisted`: the write claimed success but the effect is not readable; fall through.
 *  - `unverified`: not a persisting write (or the read-back failed open); the existing
 *    service-error / return path decides. */
export type VerifiedWriteSettle =
  | { kind: "empty_terminal" }
  | { kind: "terminal_persisted"; returns: boolean; content: unknown }
  | { kind: "persisted"; returns: true; content: unknown }
  | { kind: "not_persisted" }
  | { kind: "unverified" };

export function settleVerifiedWrite(
  v: WriteVerification,
  terminalWrite: boolean,
  persistedBodyEmpty: (content: unknown) => boolean,
): VerifiedWriteSettle {
  if (v !== null && "persisted" in v && v.persisted === true && terminalWrite && persistedBodyEmpty(v.content)) {
    return { kind: "empty_terminal" };
  } else if (v !== null && "persisted" in v && v.persisted === true && terminalWrite) {
    // A verified, APPLIED write ends the attempt. Falling through here (the old "defer so later
    // branches can still emit it") could not un-apply the write: the read-back was dropped, the
    // action-then-read path picked a sibling that failed and returned null, and the walk applied
    // the same write again from its retry, producer-scan and bridge sites.
    return { kind: "terminal_persisted", returns: true, content: v.content };
  } else if (v !== null && "persisted" in v && v.persisted === true) {
    return { kind: "persisted", returns: true, content: v.content };
  } else if (v !== null && "persisted" in v && v.persisted === false) {
    return { kind: "not_persisted" };
  }
  return { kind: "unverified" };
}

export interface AppliedWrite {
  /** Which walk site applied it (direct, transient-retry, arg-correction, action, ...). */
  site: string;
  endpoint?: string;
  result: unknown;
}

export interface AppliedWriteLedgerOptions {
  /** The durable trace writer (activity-api trace sink in production, a stub in tests). */
  persist: (trace: ExecutionTrace) => Promise<void> | void;
  /** The walk's terminal output shapes: a verified terminal write is never re-applied. */
  terminalShapes: ReadonlySet<string>;
  /** The dispatch's own tags (operator:..., surface), carried onto each record. */
  tags?: readonly string[];
  /** The walk's latest execution id, so the record hangs off the step that led to it. */
  parentExecutionId?: () => string | undefined;
  /** True when `shape` writes the store the goal asked for (its targets or terminals, by storeFamilyOf).
   *  Only such a write can anchor a mint: a confirmed side write is an effect, not the goal's product. */
  deliverable?: (shape: string) => boolean;
  now?: () => number;
}

/** One write the walk SENT, as a task of the step that sent it. The pointer is kept the way the step audit
 *  keeps a step's inputs (satisfierStepAudit): its field names and a digest, plus the engine's resolvedConfig
 *  redaction (secret-named keys replaced) with a short value cap, because a write body is often a pool payload
 *  bound in whole (bindBody), and the trace needs the arguments' form, not the payload. */
export interface WriteTaskRecord {
  task_id: string;
  shape: string;
  site: string;
  endpoint: string | null;
  bound_fields: string[];
  pointer_digest: StepContentDigest | null;
  resolved_config?: Record<string, unknown>;
  /** The record id or title the vessel's answer names (writtenRecordIdOf), null when it names none. */
  output_ref: string | null;
  success: boolean;
  refusal: string | null;
  deliverable: boolean;
  /** Set only when a later read of the store held output_ref: the read-back that confirmed THIS task. */
  read_back: { read_shape: string; confirmed_id: string; write_task_id: string; site: string } | null;
}

/** What one rawResolve of a write shape ended with: the result (null = refused or failed) and the pointer sent. */
export interface WriteOutcome {
  site: string;
  endpoint?: string;
  pointer?: Record<string, unknown>;
  result: unknown;
  reason?: string | null;
}

/** Value cap for a write task's resolvedConfig (the engine's default is 600): field values are kept short
 *  enough that a bound pool body is cut, with the cut stated, rather than copied into the trace. */
export const WRITE_TASK_VALUE_CAP = 160;

export interface AppliedWriteLedger {
  /** Called for every write a vessel accepted (non-null resolve), whatever the walk does next. */
  recordApplied(shape: string, write: AppliedWrite): void;
  /** Called where the walk independently read the write back as persisted. Links a read-back noted for the
   *  shape (noteReadBack) to the latest accepted write task of that shape. */
  markVerified(shape: string): void;
  /** False when re-applying `shape` would repeat a terminal write already verified in this walk. */
  mayApply(shape: string): boolean;
  /** How many times this walk applied `shape`. */
  appliedCount(shape: string): number;
  /** Called for EVERY rawResolve of a write shape, accepted or not: keeps it as a write task. A refused or
   *  failed write is a failed task and also gets its own failed, β-withheld satellite record. */
  recordOutcome(shape: string, outcome: WriteOutcome): WriteTaskRecord;
  /** The walk's read of the written store held this id: kept until markVerified links it. */
  noteReadBack(writeShape: string, readBack: { readShape: string; confirmedId: string; site: string }): void;
  /** Link a confirming read-back to the latest accepted, unlinked write task of `writeShape` now. */
  confirmReadBack(writeShape: string, readBack: { readShape: string; confirmedId: string; site: string }): boolean;
  /** A position in the walk's write tasks; tasksSince(mark) is what a step sent after it. */
  mark(): number;
  tasksSince(mark: number): WriteTaskRecord[];
}

let appliedWriteSeq = 0;

/** The durable record of one applied write. It is a SATELLITE: id `walk-satisfier-...` and
 *  templateId `satisfier:<shape>`, with NO `reached:` tag, so activity-api's classifyReach falls
 *  through to isHollowSatellite and grades it `ungraded` (skip). A write is evidence of an effect,
 *  not a verdict on the goal; the walk's own verdict lands on the walk's trace. */
export function appliedWriteTrace(
  shape: string,
  write: AppliedWrite,
  attempt: number,
  opts: Pick<AppliedWriteLedgerOptions, "terminalShapes" | "tags" | "parentExecutionId" | "now">,
): ExecutionTrace {
  const at = (opts.now ?? Date.now)();
  const terminal = opts.terminalShapes.has(shape);
  return {
    id: `walk-satisfier-write-${++appliedWriteSeq}-${at}`,
    templateId: `satisfier:${shape}`,
    templateName: `applied write (${shape}) at ${write.site}`,
    status: "completed",
    parentExecutionId: opts.parentExecutionId?.(),
    inputImpulseIds: [],
    outputImpulseIds: [],
    tasks: [{
      taskId: "write-apply",
      description: `apply ${shape} via ${write.endpoint ?? "connected vessel"} (walk site ${write.site}, attempt ${attempt})`,
      resolverId: shape,
      resolverTier: "pattern",
      inputImpulseIds: [],
      outputImpulseIds: [],
      outputShapes: [shape],
      success: true,
    }],
    costUsd: 0,
    durationMs: 0,
    tags: [...(opts.tags ?? []).filter((t) => !t.startsWith("reached:")), "satellite:non_terminal", `satisfier_shape:${shape}`, "write_applied", `write_site:${write.site}`],
    metadata: { satisfier: true, write_applied: true, shape, site: write.site, attempt, terminal, endpoint: write.endpoint ?? null },
  };
}

/** The durable record of one REFUSED or failed write: the same satellite as appliedWriteTrace, status failed, its
 *  task failed with the refusal. β-withheld (withBetaWithheld): a failed untagged row still took β on insert, and
 *  a vessel refusing bad arguments is the walk's synthesis failing, not the satisfier arm. */
export function refusedWriteTrace(
  w: WriteTaskRecord,
  opts: Pick<AppliedWriteLedgerOptions, "terminalShapes" | "tags" | "parentExecutionId" | "now">,
): ExecutionTrace {
  const at = (opts.now ?? Date.now)();
  const base = (opts.tags ?? []).filter((t) => !t.startsWith("reached:"));
  return {
    id: `walk-satisfier-write-${++appliedWriteSeq}-${at}`,
    templateId: `satisfier:${w.shape}`,
    templateName: `refused write (${w.shape}) at ${w.site}`,
    status: "failed",
    reason: w.refusal ?? "write refused",
    parentExecutionId: opts.parentExecutionId?.(),
    inputImpulseIds: [],
    outputImpulseIds: [],
    tasks: [writeTaskOf(w)],
    costUsd: 0,
    durationMs: 0,
    tags: withBetaWithheld([...base, "satellite:non_terminal", `satisfier_shape:${w.shape}`, "write_refused", `write_site:${w.site}`], "write-refused"),
    metadata: { satisfier: true, write_applied: false, shape: w.shape, site: w.site, terminal: opts.terminalShapes.has(w.shape), endpoint: w.endpoint, write_tasks: [w] },
  };
}

/** The record id a write's answer names: `id` or `title` at the top level, under `body`, one object level below
 *  `body` (uiView_write answers { body: { region, revision, view: { id } } }), or in a JSON `content` string. The
 *  walk's read-back (index.ts verifyWritePersistedRead) reads it the same way. */
export function writtenRecordIdOf(result: unknown): string | undefined {
  let v: unknown = result;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return undefined; } }
  if (typeof v !== "object" || v === null) return undefined;
  const obj = v as Record<string, unknown>;
  const asObj = (x: unknown): Record<string, unknown> | null => (typeof x === "object" && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : null);
  const idIn = (src: Record<string, unknown> | null): string | undefined => {
    if (!src) return undefined;
    if (typeof src["id"] === "string" && src["id"]) return src["id"];
    if (typeof src["title"] === "string" && src["title"]) return src["title"];
    return undefined;
  };
  const body = asObj(obj["body"]);
  const direct = idIn(obj) ?? idIn(body);
  if (direct) return direct;
  if (typeof obj["content"] === "string") {
    try { const inner = idIn(asObj(JSON.parse(obj["content"]))); if (inner) return inner; } catch { /* not JSON */ }
  }
  if (body) for (const k of Object.keys(body).sort()) { const nested = idIn(asObj(body[k])); if (nested) return nested; }
  return undefined;
}

/** The shape the walk reads a write back through. The name derivation is the walk's own (strip `_write`, then a
 *  `<verb>_create`, then a trailing `_<verb>`); when the store serves no shape by that name, the one served read
 *  shape of the same store (reach-grounding.ts storeFamilyOf) is used, so uiView_write reads back through
 *  human_surface:ui_view instead of the unadvertised `uiView` (finding agf_j0wy8r5qx6mc). No match, or more
 *  than one, keeps the derived name: an ambiguous store is not guessed. */
export function writeReadShape(writeShape: string, served: Iterable<string>): string {
  let readShape = writeShape.replace(/_write$/, "");
  readShape = readShape.replace(/^[a-z]+_create$/, (m) => m.replace(/_create$/, ""));
  readShape = readShape.replace(/_[a-z]+$/, "") || readShape;
  const servedSet = new Set(served);
  if (servedSet.has(readShape)) return readShape;
  const family = storeFamilyOf(writeShape);
  const same = [...servedSet].filter((s) => !isStoreWriteShape(s) && !/_(?:create|update|delete)$/.test(s) && storeFamilyOf(s) === family);
  return same.length === 1 ? same[0]! : readShape;
}

/** Does a read of the store hold the record a write named? Only an id the write's own answer named confirms it;
 *  a write that names none is never confirmed here (an always-answering read, a whole view, proves nothing). */
export function readBackConfirms(writeResult: unknown, readResult: unknown): string | null {
  const id = writtenRecordIdOf(writeResult);
  if (!id || readResult == null) return null;
  try { return JSON.stringify(readResult).includes(id) ? id : null; } catch { return null; }
}

/** A write task as the step trace lists it (ExecutionTaskRecord; the audit fields ride in metadata.write_tasks). */
export function writeTaskOf(w: WriteTaskRecord): ExecutionTrace["tasks"][number] {
  return {
    taskId: w.task_id,
    description: `${w.success ? "apply" : "refused"} ${w.shape} via ${w.endpoint ?? "connected vessel"} (walk site ${w.site})`,
    resolverId: w.shape,
    resolverTier: "pattern",
    ...(w.resolved_config ? { resolvedConfig: w.resolved_config } : {}),
    inputImpulseIds: [],
    outputImpulseIds: [],
    outputShapes: w.success ? [w.shape] : [],
    success: w.success,
    ...(w.refusal ? { error: w.refusal } : {}),
  };
}

/** A step's writes placed against the step's own task. When the step's task already names the shape a write
 *  wrote (the direct path: the satisfier was asked for the write shape itself), the LAST accepted write of it IS
 *  that task: its record is relabelled onto the task and the task takes its resolvedConfig, so a recipe extracted
 *  from the trace replays the write once, not twice. Every other write follows as its own task. */
function placeStepWrites(
  stepTask: ExecutionTrace["tasks"][number] | undefined,
  writes: readonly WriteTaskRecord[],
): { after: ExecutionTrace["tasks"]; records: WriteTaskRecord[] } {
  let mergeAt = -1;
  if (stepTask) for (let i = writes.length - 1; i >= 0; i--) if (writes[i]!.success && writes[i]!.shape === stepTask.resolverId) { mergeAt = i; break; }
  const after: ExecutionTrace["tasks"] = [];
  const records = writes.map((w, i) => {
    if (i !== mergeAt || !stepTask) { after.push(writeTaskOf(w)); return w; }
    if (w.resolved_config) stepTask.resolvedConfig = w.resolved_config;
    return { ...w, task_id: stepTask.taskId, read_back: w.read_back ? { ...w.read_back, write_task_id: stepTask.taskId } : null };
  });
  return { after, records };
}

/** Add a step's write tasks to its trace (the step's own task is its first): the records ride in metadata.write_tasks. */
export function attachWriteTasks(trace: ExecutionTrace, writes: readonly WriteTaskRecord[]): ExecutionTrace {
  if (writes.length === 0) return trace;
  const { after, records } = placeStepWrites(trace.tasks[0], writes);
  trace.tasks.push(...after);
  const meta = trace.metadata ?? (trace.metadata = {});
  const prior = Array.isArray(meta["write_tasks"]) ? meta["write_tasks"] as WriteTaskRecord[] : [];
  meta["write_tasks"] = [...prior, ...records];
  return trace;
}

/** The walk's composite rebuilds its tasks from the chain (buildCompositeTraceFromChain), which drops a step's write
 *  tasks. Put each step's ACCEPTED writes back against that step's task (a refused write changed nothing and is not
 *  part of a recipe; it stays on the step's own trace). `byStep` is keyed by chain index, as stepEdges is. */
export function spliceStepWrites(trace: ExecutionTrace, byStep: ReadonlyMap<number, readonly WriteTaskRecord[]>): ExecutionTrace {
  if (![...byStep.values()].some((ws) => ws.some((w) => w.success))) return trace;
  const tasks: ExecutionTrace["tasks"] = [];
  const kept: WriteTaskRecord[] = [];
  trace.tasks.forEach((t, i) => {
    const own = { ...t };
    const { after, records } = placeStepWrites(own, (byStep.get(i) ?? []).filter((w) => w.success));
    tasks.push(own, ...after);
    kept.push(...records);
  });
  return { ...trace, tasks, metadata: { ...(trace.metadata ?? {}), write_tasks: kept } };
}

/** THE EXECUTED-TOOL ANCHOR A WRITE GIVES (the mint gate, index.ts mintReachedTrace). True iff the trace itself
 *  holds a successful task writing the goal's store (deliverable, not the walk's own pool mechanics) whose record a
 *  later read confirmed by the id the write named. A claim with no write task, an accepted write never confirmed,
 *  a refused write and a write in another trace of the walk give none. */
export function hasVerifiedWriteAnchor(trace: Pick<ExecutionTrace, "tasks" | "metadata"> | null | undefined): boolean {
  const recs = Array.isArray(trace?.metadata?.["write_tasks"]) ? trace!.metadata!["write_tasks"] as WriteTaskRecord[] : [];
  return (trace?.tasks ?? []).some((t) => t.success === true && isStoreWriteShape(t.resolverId) && !WALK_MECHANICS_WRITES.has(t.resolverId)
    && recs.some((r) => r.task_id === t.taskId && r.shape === t.resolverId && r.success === true && r.deliverable === true
      && r.read_back !== null && r.read_back.write_task_id === t.taskId && typeof r.read_back.confirmed_id === "string" && r.read_back.confirmed_id.length > 0));
}

/** The mint gate's grounding: the walk's own anchors (isGroundedHonestReach), or a confirmed write task in this trace. */
export function groundedForMint(grounded: boolean, trace: Pick<ExecutionTrace, "tasks" | "metadata"> | null | undefined): boolean {
  return grounded || hasVerifiedWriteAnchor(trace);
}

let writeTaskSeq = 0;

export function createAppliedWriteLedger(opts: AppliedWriteLedgerOptions): AppliedWriteLedger {
  const applied = new Map<string, number>();
  const verified = new Set<string>();
  const writeTasks: WriteTaskRecord[] = [];
  const pendingReadBack = new Map<string, { readShape: string; confirmedId: string; site: string }>();
  const link = (writeShape: string, rb: { readShape: string; confirmedId: string; site: string }): boolean => {
    for (let i = writeTasks.length - 1; i >= 0; i--) {
      const w = writeTasks[i]!;
      if (w.shape !== writeShape || !w.success || w.read_back !== null) continue;
      if (w.output_ref !== rb.confirmedId) return false;
      w.read_back = { read_shape: rb.readShape, confirmed_id: rb.confirmedId, write_task_id: w.task_id, site: rb.site };
      return true;
    }
    return false;
  };
  return {
    recordOutcome(shape: string, o: WriteOutcome): WriteTaskRecord {
      const ok = o.result != null;
      let digest: StepContentDigest | null = null;
      try { digest = o.pointer ? stepContentDigest(o.pointer) : null; } catch { digest = null; }
      const w: WriteTaskRecord = {
        task_id: `write-${++writeTaskSeq}`,
        shape,
        site: o.site,
        endpoint: o.endpoint ?? null,
        bound_fields: Object.keys(o.pointer ?? {}).sort(),
        pointer_digest: digest,
        ...(o.pointer ? { resolved_config: redactResolvedConfig(o.pointer, WRITE_TASK_VALUE_CAP) } : {}),
        output_ref: ok ? (writtenRecordIdOf(o.result) ?? null) : null,
        success: ok,
        refusal: ok ? null : String(o.reason ?? "write refused").slice(0, 300),
        deliverable: (() => { try { return opts.deliverable?.(shape) === true; } catch { return false; } })(),
        read_back: null,
      };
      writeTasks.push(w);
      if (!ok) {
        try {
          void Promise.resolve(opts.persist(refusedWriteTrace(w, opts))).catch((e) => {
            console.warn(`[goal-host] refused-write trace for ${shape} not persisted (this refusal stays untraced): ${(e as Error).message}`);
          });
        } catch (e) {
          console.warn(`[goal-host] refused-write trace for ${shape} not built (this refusal stays untraced): ${(e as Error).message}`);
        }
      }
      return w;
    },
    noteReadBack(writeShape, rb): void { pendingReadBack.set(writeShape, rb); },
    confirmReadBack(writeShape, rb): boolean { return link(writeShape, rb); },
    mark(): number { return writeTasks.length; },
    tasksSince(m: number): WriteTaskRecord[] { return writeTasks.slice(Math.max(0, m)); },
    recordApplied(shape: string, write: AppliedWrite): void {
      const attempt = (applied.get(shape) ?? 0) + 1;
      applied.set(shape, attempt);
      try {
        void Promise.resolve(opts.persist(appliedWriteTrace(shape, write, attempt, opts))).catch((e) => {
          console.warn(`[goal-host] applied-write trace for ${shape} not persisted (this write stays untraced): ${(e as Error).message}`);
        });
      } catch (e) {
        console.warn(`[goal-host] applied-write trace for ${shape} not built (this write stays untraced): ${(e as Error).message}`);
      }
    },
    markVerified(shape: string): void {
      verified.add(shape);
      const rb = pendingReadBack.get(shape);
      if (rb) { pendingReadBack.delete(shape); link(shape, rb); }
    },
    mayApply(shape: string): boolean { return !(opts.terminalShapes.has(shape) && verified.has(shape)); },
    appliedCount(shape: string): number { return applied.get(shape) ?? 0; },
  };
}

/** The body rawResolve POSTs for one walk resolve, moved verbatim from index.ts. The LLM
 *  resolver reads a TOP-LEVEL `prompt` (a prompt nested only in impulse.pointer is ignored,
 *  verified live), so it is threaded up for llm_completion. `extras` are the caller/dispatch
 *  fields index.ts adds for that case. */
export function walkResolveBody(
  shape: string,
  pointer: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = (shape === "llm_completion" || shape === "llmCompletion") && typeof pointer.prompt === "string"
    ? { impulse: { pointer }, prompt: pointer.prompt, ...extras }
    : { impulse: { pointer } };
  return stripWalkOperatorMarker(shape, body);
}

/** The whole POST body of a walk write, top level and impulse.pointer included, loses any
 *  `operator` marker (resolve-pointer.ts stripOperatorMarker). buildResolvePointer already
 *  strips the pointer; this covers the body around it. Endpoint-override fields (Url / Endpoint
 *  suffixes, resolve-pointer.ts stripEndpointOverrides) are dropped from the body the same way. */
export function stripWalkOperatorMarker(shape: string, body: Record<string, unknown>): Record<string, unknown> {
  return stripEndpointOverrides(shape, stripOperatorMarker(shape, body));
}
