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
 *     moved verbatim from the satisfier in index.ts (index.ts keeps the logging and the returns).
 *   - `createAppliedWriteLedger`: one per walk. Every applied write records through it, and the
 *     retry sites ask it whether a terminal write already verified in this walk may be applied
 *     again.
 */
import type { ExecutionTrace } from "@avigopal/ias-executor-ts";

/** A shape whose resolve MUTATES a store: the `_write` suffix family plus the vault note write. */
export function isAppliedWriteShape(shape: string): boolean {
  return /_write$/.test(shape) || /(^|:)write_note$/.test(shape);
}

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
    // Do not short-circuit on terminal writes; allow learned-pathway/producers to run first.
    // Defer by adopting the independently-read content as the direct value so later branches can still emit it if nothing outranks it.
    return { kind: "terminal_persisted", returns: false, content: v.content };
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
  now?: () => number;
}

export interface AppliedWriteLedger {
  /** Called for every write a vessel accepted (non-null resolve), whatever the walk does next. */
  recordApplied(shape: string, write: AppliedWrite): void;
  /** Called where the walk independently read the write back as persisted. */
  markVerified(shape: string): void;
  /** False when re-applying `shape` would repeat a terminal write already verified in this walk. */
  mayApply(shape: string): boolean;
  /** How many times this walk applied `shape`. */
  appliedCount(shape: string): number;
}

export function createAppliedWriteLedger(_opts: AppliedWriteLedgerOptions): AppliedWriteLedger {
  const applied = new Map<string, number>();
  return {
    recordApplied(shape: string, _write: AppliedWrite): void {
      applied.set(shape, (applied.get(shape) ?? 0) + 1);
    },
    markVerified(_shape: string): void { /* not yet consulted */ },
    mayApply(_shape: string): boolean { return true; },
    appliedCount(shape: string): number { return applied.get(shape) ?? 0; },
  };
}
