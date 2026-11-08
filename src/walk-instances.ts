/**
 * THE WALK'S POOL HOLDS SEVERAL INSTANCES OF A SHAPE (walk activity only; pure, no I/O).
 *
 * A walk used to keep one impulse per shape: addToPool dropped a second one, and a producer whose resolve failed was
 * marked "tried" for the rest of the walk. A goal that needs the same shape twice (a test run before and after a
 * change), or a hop that can only succeed once its evidence arrives, could not be walked. This module holds the three
 * pieces of walk-local state that replace that assumption. The walk (runGoalAsPoolWalkBody) creates one of each per
 * walk; nothing here is module-level or shared across walks.
 *
 *   1. The INSTANCE KEY: shape + a canonical hash of the BOUND inputs of the send that produced it. Pool context that
 *      rides in every pointer is not part of the key, so "identical" means the same shape with the same value of every
 *      bound field (key order ignored).
 *   2. The ATTEMPT LEDGER, keyed by producer: a producer may be attempted again only after the pool gained an impulse
 *      it did not hold at the last attempt, and only within the walk budget's max_attempts_per_producer. An absent
 *      budget field means no re-attempt after a failure. Attempts are counted since the producer's last success; a
 *      transient outcome observed nothing, so it does not move the version the next attempt is compared against.
 *   3. DEMANDS: an unmet input of a hop becomes a demanded shape. A demand is met only by an instance added after the
 *      demand was raised and, when the demand carries a binding, only by an instance whose bound fields equal it.
 */
import { createHash } from "node:crypto";

/** Fields never part of an instance key: attribution and routing, not inputs. The shape is already in the key. */
export const INSTANCE_KEY_EXCLUDED: ReadonlySet<string> = new Set(["execution_id", "dispatch_id", "caller", "task_type", "provenance", "type"]);

/** JSON with object keys sorted at every depth, so two equal values serialize the same whatever their key order. */
export function stableJSON(v: unknown): string {
  const norm = (x: unknown, depth: number): unknown => {
    if (depth > 32 || x === null || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map((e) => norm(e, depth + 1));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>).sort()) out[k] = norm((x as Record<string, unknown>)[k], depth + 1);
    return out;
  };
  const s = JSON.stringify(norm(v, 0));
  return s === undefined ? "null" : s;
}

/** The pointer's bound fields: the named fields that are present, minus the excluded attribution fields. */
export function boundFieldsOf(pointer: Record<string, unknown> | null | undefined, names: Iterable<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!pointer) return out;
  for (const n of names) {
    if (INSTANCE_KEY_EXCLUDED.has(n) || !(n in pointer) || pointer[n] === undefined) continue;
    out[n] = pointer[n];
  }
  return out;
}

/** shape + "#" + the first 16 hex of sha256 over the canonical bound fields. */
export function instanceKey(shape: string, pointer: Record<string, unknown> | null | undefined, boundFieldNames: Iterable<string>): string {
  return `${shape}#${createHash("sha256").update(stableJSON(boundFieldsOf(pointer, boundFieldNames))).digest("hex").slice(0, 16)}`;
}

/** The key of an impulse whose adder names no instance: one instance per (shape, producer), so a site that adds the
 *  same shape from the same producer again keeps the first, as the pool always did. */
export function defaultInstanceKey(shape: string, producedBy: string | undefined): string {
  return instanceKey(shape, { producedBy: producedBy ?? "goal-host-walk" }, ["producedBy"]);
}

type ShapedLike = { metadata?: unknown };
const shapeOf = (i: ShapedLike): string | undefined => {
  const s = (i.metadata as { shape?: unknown } | undefined)?.shape;
  return typeof s === "string" ? s : undefined;
};

/** The pool as the walk binds from it: the NEWEST instance of each shape, in pool order. With one instance per shape
 *  this is the pool itself. */
export function newestPerShape<T extends ShapedLike>(pool: readonly T[]): T[] {
  const last = new Map<string, number>();
  pool.forEach((imp, i) => { const s = shapeOf(imp); if (s !== undefined) last.set(s, i); });
  return pool.filter((imp, i) => { const s = shapeOf(imp); return s === undefined || last.get(s) === i; });
}

// ── the attempt ledger ──────────────────────────────────────────────────────

export type AttemptOutcome = "ok" | "curable" | "transient" | "structural";
/** One send an attempt made: whether it reached egress, and how it ended. */
export interface AttemptSend { reachedEgress: boolean; ok: boolean; transient: boolean; key?: string }

/** One outcome per attempt: STRUCTURAL if any refusal was structural; OK if the attempt produced; else TRANSIENT if every
 *  failed send that reached egress was transient (and there was one); else CURABLE. Sends refused before egress do not
 *  count toward TRANSIENT. */
export function attemptOutcome(a: { ok: boolean; structural: boolean; sends: readonly AttemptSend[] }): AttemptOutcome {
  if (a.structural) return "structural";
  if (a.ok) return "ok";
  const failedAtEgress = a.sends.filter((s) => s.reachedEgress && !s.ok);
  if (failedAtEgress.length > 0 && failedAtEgress.every((s) => s.transient)) return "transient";
  return "curable";
}

/** Why a producer may or may not be attempted now. "needs-cap": a re-attempt is due and only the cap decides. */
export type AttemptDecision = "first" | "suppressed" | "structural" | "no-new-impulse" | "needs-cap";

export interface ProducerAttempts { attempts: number; lastAttemptVersion: number; lastOutcome?: AttemptOutcome }

export class AttemptLedger {
  private readonly byProducer = new Map<string, ProducerAttempts>();
  private readonly suppressed: ReadonlySet<string>;
  private readonly failed = new Set<string>();
  /** Re-attempts made this walk; each one counts against the walk's step budget. */
  reattempts = 0;

  /** `suppressed`: producers never attempted this walk (structural from the start). */
  constructor(suppressed: Iterable<string> = []) { this.suppressed = new Set(suppressed); }

  state(p: string): ProducerAttempts | undefined { return this.byProducer.get(p); }

  /** In this order: suppressed or structural -> no; never attempted since the last success -> first; no impulse added
   *  since the last attempt -> no; otherwise the cap decides. */
  decide(p: string, poolVersion: number): AttemptDecision {
    if (this.suppressed.has(p)) return "suppressed";
    const s = this.byProducer.get(p);
    if (s?.lastOutcome === "structural") return "structural";
    if (!s || s.attempts === 0) return "first";
    if (!(poolVersion > s.lastAttemptVersion)) return "no-new-impulse";
    return "needs-cap";
  }

  /** The cap's verdict on a due re-attempt: an absent cap (null) means re-attempts are off. */
  withinCap(p: string, cap: number | null): boolean {
    if (cap === null || !Number.isFinite(cap)) return false;
    return (this.byProducer.get(p)?.attempts ?? 0) < cap;
  }

  /** Start an attempt. Returns whether it is a re-attempt (counted in `reattempts`). */
  begin(p: string): { reattempt: boolean } {
    const s = this.byProducer.get(p) ?? { attempts: 0, lastAttemptVersion: -1 };
    const reattempt = s.attempts > 0;
    if (reattempt) this.reattempts++;
    s.attempts++;
    this.byProducer.set(p, s);
    return { reattempt };
  }

  /** End an attempt. `poolVersion` is read after the attempt (its own output, if any, included), so nothing the attempt
   *  itself added can re-arm it. A success resets the count; a transient outcome leaves the version where it was. The
   *  failed non-transient sends' keys join the failed instances (they block identical sends of LATER attempts). */
  end(p: string, outcome: AttemptOutcome, poolVersion: number, sends: readonly AttemptSend[] = []): void {
    const s = this.byProducer.get(p) ?? { attempts: 1, lastAttemptVersion: -1 };
    s.lastOutcome = outcome;
    if (outcome === "ok") s.attempts = 0;
    if (outcome !== "transient") s.lastAttemptVersion = poolVersion;
    this.byProducer.set(p, s);
    if (outcome !== "ok") for (const x of sends) if (x.key && x.reachedEgress && !x.ok && !x.transient) this.failed.add(x.key);
  }

  /** An identical instance (same key) already failed in an earlier, completed attempt of this walk. */
  failedBefore(key: string): boolean { return this.failed.has(key); }

  /** Whether the walk may take another step: chain steps plus re-attempts stay under maxSteps. */
  budgetLeft(chainLength: number, maxSteps: number): boolean { return chainLength + this.reattempts < maxSteps; }

  /** Whether a re-attempt fits the step budget. A successful re-attempt costs two (the re-attempt and the chain step it
   *  pushes), so it is allowed only while both fit: chain steps plus re-attempts then never exceed maxSteps. */
  budgetAllowsReattempt(chainLength: number, maxSteps: number): boolean { return chainLength + this.reattempts + 2 <= maxSteps; }
}

// ── instances and demands ───────────────────────────────────────────────────

export interface InstanceRecord { id: string; key: string; version: number; bound?: Record<string, unknown> }

/** Every instance this walk added, by shape, in order. */
export class InstanceIndex {
  private readonly byShape = new Map<string, InstanceRecord[]>();
  private readonly keys = new Set<string>();
  hasKey(key: string): boolean { return this.keys.has(key); }
  add(shape: string, rec: InstanceRecord): number {
    const list = this.byShape.get(shape) ?? [];
    list.push(rec);
    this.byShape.set(shape, list);
    this.keys.add(rec.key);
    return list.length;
  }
  of(shape: string): readonly InstanceRecord[] { return this.byShape.get(shape) ?? []; }
  newest(shape: string): InstanceRecord | undefined { const l = this.byShape.get(shape); return l?.[l.length - 1]; }
}

/** A hop input the walk could not bind: the field, and the shape the producer's contract binds it from (null: none). */
export interface UnmetInput { hop: string; field: string; shape: string | null; reason: string }

/** A demand key is {shape, binding?}: an absent binding is shape-level. */
export interface Demand { shape: string; binding?: Record<string, unknown>; since: number; forHop: string; reason: string }

/** The demand's bound fields all equal the instance's bound fields (canonical comparison). */
export function bindingMatches(binding: Record<string, unknown> | undefined, bound: Record<string, unknown> | undefined): boolean {
  if (!binding) return true;
  const b = bound ?? {};
  return Object.keys(binding).every((k) => k in b && stableJSON(binding[k]) === stableJSON(b[k]));
}

export class DemandBook {
  private readonly demands = new Map<string, Demand>();
  /** Raise (or renew) the demand for a shape. A later demand replaces an earlier one: what was in the pool when it was
   *  raised did not satisfy the hop. */
  note(d: Demand): void { this.demands.set(d.shape, { ...d }); }
  get(shape: string): Demand | undefined { return this.demands.get(shape); }
  all(): Demand[] { return [...this.demands.values()]; }
  /** Present, and (when demanded) an instance added after the demand whose bound fields match its binding. With no
   *  demand for the shape this is just `present`. */
  shapeMet(shape: string, present: boolean, index: InstanceIndex): boolean {
    if (!present) return false;
    const d = this.demands.get(shape);
    if (!d) return true;
    return index.of(shape).some((r) => r.version > d.since && bindingMatches(d.binding, r.bound));
  }
}
