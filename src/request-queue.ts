/**
 * THE RESOLVER REQUEST QUEUE: work this node's walks ask of a resolver outside the process (a person through a
 * human_input surface, an agent leasing through requestLease), kept durable across a restart.
 *
 * WHY. A walk that asked a person (solicitHumanInput, WS5) kept the question in an in-memory map only. A restart
 * emptied it: a person's late answer got a 404, the requeued walk asked again, and an agent had nothing it could take
 * as a resolver and come back to. A request now lives on disk from the moment it is asked until it SETTLES.
 *
 * THE MODEL IS THE LANDING LEASE'S (development-vessel substrate-gap.ts, LANDING LEASE), with its two lessons:
 *   - HOLDER-SERIALIZED. A request is HOMED at the node whose walk enqueued it (its data lives there, law 11); only that
 *     node's store grants, renews or settles it, so no second node can grant it. Every op here runs under one lock
 *     against a FRESH read of the store, decides with a pure rule, and saves atomically (tmp then rename).
 *   - ABSTAIN ON UNKNOWN. No store on this process, or a store that is present but unreadable, answers
 *     {unknown:true} and grants nothing. A corrupt file is never replaced by an empty one.
 *   - NO FULL-TTL ORPHAN (2026-10-22 lesson: a landing lease outlived the process that took it for its whole 2 h TTL).
 *     Two clocks: `ttl_ms` bounds the WORK a lease may take; LIVENESS is separate: the holder renews every
 *     `renew_every_ms`, and a lease that misses `grace_renewals` renewals is lapsed at once (holder_gone) and its request
 *     offered again as the next attempt. A dead holder therefore frees it within grace_renewals x renew_every_ms, a
 *     small fraction of ttl_ms (renew_every_ms is bounded to ttl/10).
 *   - EVERY REQUEST SETTLES (2026-10-22 lesson; the shape of development-vessel's settlePickDecision). Every attempt ends
 *     in a recorded outcome: the holder's answer (resolved|declined|failed|partial|need_input) or the system's
 *     (lapsed|revoked|expired|error), and every request ends settled: resolved, partial, withdrawn (its walk ended),
 *     expired (its deadline), or the waiter's own end (answered|declined|insufficient_context|timeout|error, see
 *     withRequestSettlement). The sweep runs at the head of every op and on the service's interval, so a request whose
 *     waiter died with the process still settles.
 *
 * ACCOUNT = KEY until S-4 (a principal with an account, stamped from the credential). The credential carries a key id
 * and scopes, not a user, so "the dispatcher's own account" and "an account that declined" are principal labels
 * (inbound-auth.ts principalLabel: key:<keyId>, or node-self); two keys of one person count as two accounts.
 *
 * ORIGIN (user ruling, "Autonomous if the system initiated it"). Every request records the dispatch that asked it and
 * whether that dispatch was SYSTEM- or OPERATOR-initiated, read from the dispatch's own recorded initiator (index.ts
 * DispatchRecord.initiator), never from a body. A lease-bound answer records its LEASE PROVENANCE
 * {request_id, lease_id, attempt, dispatch_id, origin} on the attempt and on the request it settles, and the waiter
 * carries it onto the dispatch record (DispatchRecord.resolverAnswers), so an answer to a system-initiated request can
 * be told from an operator act downstream.
 *
 * This module reads no environment. The store root is set by the service (index.ts main block, the dispatch store's
 * directory); an importer that is not the service has no store and abstains.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveShapedPolicy } from "./shaped-policy-store";
import { principalTag } from "./inbound-auth";

export type RequestOrigin = "system" | "operator";
export type AnswerOutcome = "resolved" | "declined" | "failed" | "partial" | "need_input";
export const ANSWER_OUTCOMES: readonly AnswerOutcome[] = ["resolved", "declined", "failed", "partial", "need_input"];
export type AttemptOutcome = AnswerOutcome | "lapsed" | "revoked" | "expired" | "error";
/** How a request ended. The first two settle from a holder's answer; the rest from the system or the waiter. */
export type RequestFinal = "resolved" | "partial" | "withdrawn" | "expired" | "answered" | "declined" | "insufficient_context" | "timeout" | "error";

/** Where a lease-bound answer came from: exactly these five fields, on the attempt, the request and the dispatch. */
export interface LeaseProvenance { request_id: string; lease_id: string; attempt: number; dispatch_id: string | null; origin: RequestOrigin }

export interface RequestAttempt {
  attempt: number;
  lease_id: string;
  /** The holder's principal label (account = key until S-4). */
  holder: string;
  /** The holder's own process instance id, for attribution only. */
  holder_instance: string | null;
  leased_at: number;
  renewed_at: number;
  renew_every_ms: number;
  grace_renewals: number;
  /** The work bound: leased_at + ttl, never past the request deadline. */
  until: number;
  ended_at?: number;
  outcome?: AttemptOutcome;
  reason?: string;
  /** "response" for the holder's answer; otherwise the system path that ended it. */
  settled_by?: string;
  answer?: unknown;
  evidence?: unknown;
  guidance_used?: unknown;
  guidance_proposal?: unknown;
  request_gaps?: unknown;
  lease_provenance?: LeaseProvenance;
  /** THE ANSWER THIS LEASE ACCEPTED (one per lease; a lease is one attempt). Minted here when the answer is accepted;
   *  goal-host echoes answer_id on the downstream record that carries the answer (DispatchRecord.resolverAnswers[]), so
   *  a reader can require "this record IS the answer this lease accepted", not ids copied into some other write. */
  answer_binding?: AnswerBinding;
}

export interface AnswerBinding { answer_id: string; accepted_at: string }

export interface ResolverRequest {
  id: string;
  dispatch_id: string | null;
  origin: RequestOrigin;
  /** The dispatching principal's label: never leased to it. */
  dispatcher: string;
  goal: string;
  goal_hash: string;
  shape: string;
  description: string;
  inputs: Record<string, unknown>;
  required: { capabilities: string[]; scopes: string[] };
  created_at: number;
  deadline: number;
  status: "pending" | "leased" | "settled";
  declined_by: string[];
  attempts: RequestAttempt[];
  outcome?: RequestFinal;
  settled_at?: number;
  settled_by?: string;
  answer?: unknown;
  answered_by?: string;
  /** The provenance of the lease-bound answer that settled it (absent when a person answered by solicitationId). */
  lease_provenance?: LeaseProvenance;
  /** The answer binding of the lease-bound answer that settled it. */
  answer_binding?: AnswerBinding;
  /** When a re-attaching waiter took the settled answer (so it is delivered once). */
  delivered_at?: number;
}

type Store = { version: 1; requests: ResolverRequest[] };

// ─── policy: read as data, every value clamped to literal bounds (the LEARNING_ROW_BOUNDS pattern) ───
export const REQUEST_QUEUE_POLICY_SHAPE = "requestQueuePolicy";
export interface QueuePolicy { ttl_ms: number; renew_every_ms: number; grace_renewals: number; retention_ms: number }
export const QUEUE_POLICY_DEFAULTS: Readonly<QueuePolicy> = Object.freeze({ ttl_ms: 30 * 60_000, renew_every_ms: 30_000, grace_renewals: 2, retention_ms: 24 * 3600_000 });
/** Literal bounds. ttl_ms is capped at 2 h (a lease is never longer than the waiter's own cap allows anyway: the request
 *  deadline bounds it); renew_every_ms upper bound is the in-force ttl / 10, so a dead holder is freed in at most half
 *  the ttl even at the widest grace. */
export const QUEUE_POLICY_BOUNDS: Readonly<Record<keyof QueuePolicy, { min: number; max: number }>> = Object.freeze({
  ttl_ms: { min: 60_000, max: 2 * 3600_000 },
  renew_every_ms: { min: 1_000, max: Number.POSITIVE_INFINITY /* ttl_ms / 10, applied below */ },
  grace_renewals: { min: 2, max: 5 },
  retention_ms: { min: 3600_000, max: 7 * 24 * 3600_000 },
});
/** The policy in force from a stored document: an absent field is the default; a field out of its bounds (or not a
 *  finite number) is ignored for the default, with a log line naming it. */
export function clampQueuePolicy(doc: Record<string, unknown> | null, log: (line: string) => void = (l) => console.warn(l)): QueuePolicy {
  const out: QueuePolicy = { ...QUEUE_POLICY_DEFAULTS };
  const take = (k: keyof QueuePolicy, max: number): void => {
    if (!doc || !(k in doc)) return;
    const v = doc[k];
    const { min } = QUEUE_POLICY_BOUNDS[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) { out[k] = v; return; }
    log(`[request-queue] ${REQUEST_QUEUE_POLICY_SHAPE}.${k}=${JSON.stringify(v)} is outside [${min}, ${max}]; the default ${QUEUE_POLICY_DEFAULTS[k]} applies`);
  };
  take("ttl_ms", QUEUE_POLICY_BOUNDS.ttl_ms.max);
  take("grace_renewals", QUEUE_POLICY_BOUNDS.grace_renewals.max);
  take("retention_ms", QUEUE_POLICY_BOUNDS.retention_ms.max);
  take("renew_every_ms", Math.floor(out.ttl_ms / 10));
  if (out.renew_every_ms > Math.floor(out.ttl_ms / 10)) out.renew_every_ms = Math.floor(out.ttl_ms / 10);
  return out;
}

// ─── process state ───
type Deps = {
  now: () => number;
  readPolicy: () => Promise<Record<string, unknown> | null>;
  /** The state of a dispatch on this node: running, ended, or unknown (no record: abstain, the deadline bounds it). */
  dispatchState: (dispatchId: string) => "running" | "ended" | "unknown";
};
const liveDeps: Deps = { now: Date.now, readPolicy: () => resolveShapedPolicy(REQUEST_QUEUE_POLICY_SHAPE), dispatchState: () => "unknown" };
let deps: Deps = liveDeps;
let root: string | null = null;
const counts = {
  enqueued: 0, reattached: 0, leased: 0, renewed: 0, answers_accepted: 0,
  refused_duplicate: 0, refused_late: 0, refused_not_holder: 0, refused_unknown_lease: 0,
  lapsed: 0, revoked: 0, expired: 0, withdrawn: 0, settled_by_waiter: 0, settled_on_error: 0, unknown: 0, pruned: 0,
};
export function requestQueueCounters(): Readonly<typeof counts> { return { ...counts }; }
/** The service sets the store's directory (the dispatch store's). Null removes it (an importer's state). */
export function setRequestQueueRoot(dir: string | null): void { root = dir; }
export function requestQueuePath(): string | null { return root ? join(root, "goal-host-requests.json") : null; }
/** index.ts binds the dispatch-state reader to its executionStore. */
export function setRequestQueueDispatchReader(fn: Deps["dispatchState"]): void { liveDeps.dispatchState = fn; if (deps !== liveDeps) deps = { ...deps, dispatchState: fn }; }
/** Tests only: replace the clock / policy read / dispatch reader (null restores them) and zero the counters. */
export function __setRequestQueueDepsForTests(d: Partial<Deps> | null): void {
  deps = d ? { ...liveDeps, ...d } : liveDeps;
  for (const k of Object.keys(counts) as Array<keyof typeof counts>) counts[k] = 0;
}

class StoreUnknown extends Error {}
let chain: Promise<unknown> = Promise.resolve();
/** THE serialization point: every op on this node's requests runs here, one at a time. */
function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
async function loadStore(): Promise<Store> {
  const p = requestQueuePath();
  if (!p) throw new StoreUnknown("no request store on this process");
  let raw: string;
  try { raw = await readFile(p, "utf-8"); } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, requests: [] };
    throw new StoreUnknown(`request store unreadable: ${String((err as Error).message).slice(0, 160)}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new StoreUnknown("request store does not parse; it is left as it is"); }
  const reqs = (parsed as { requests?: unknown } | null)?.requests;
  if (!Array.isArray(reqs)) throw new StoreUnknown("request store has no requests array; it is left as it is");
  return { version: 1, requests: reqs as ResolverRequest[] };
}
async function saveStore(s: Store): Promise<void> {
  const p = requestQueuePath();
  if (!p) throw new StoreUnknown("no request store on this process");
  await mkdir(root!, { recursive: true }).catch(() => undefined);
  const tmp = `${p}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(s), "utf-8");
  await rename(tmp, p);
}
/** One op: lock, fresh read, policy, sweep, the decision, save when anything changed. */
async function op<T>(fn: (s: Store, pol: QueuePolicy, now: number) => { result: T; changed: boolean }): Promise<T | { unknown: true; reason: string }> {
  return withQueueLock(async () => {
    try {
      const s = await loadStore();
      const pol = clampQueuePolicy(await deps.readPolicy().catch(() => null));
      const now = deps.now();
      const swept = sweepStore(s, pol, now);
      const { result, changed } = fn(s, pol, now);
      if (swept || changed) await saveStore(s);
      return result;
    } catch (err) {
      counts.unknown += 1;
      const reason = err instanceof StoreUnknown ? err.message : `request store op failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`;
      console.warn(`[request-queue] abstain: ${reason}`);
      return { unknown: true as const, reason };
    }
  });
}
export function isUnknown(x: unknown): x is { unknown: true; reason: string } { return !!x && typeof x === "object" && (x as { unknown?: unknown }).unknown === true; }

// ─── the pure rules ───
const sameAccount = (a: string, b: string): boolean => (a.startsWith("node-self") && b.startsWith("node-self")) || a === b;
const activeAttempt = (r: ResolverRequest): RequestAttempt | undefined => r.attempts.find((a) => a.ended_at === undefined);
function endAttempt(a: RequestAttempt, outcome: AttemptOutcome, reason: string, by: string, now: number): void {
  a.ended_at = now; a.outcome = outcome; a.reason = reason; a.settled_by = by;
}
function settleRequest(r: ResolverRequest, final: RequestFinal, by: string, now: number, extra: Partial<ResolverRequest> = {}): void {
  const a = activeAttempt(r);
  if (a) { endAttempt(a, "revoked", "request_settled", by, now); counts.revoked += 1; }
  Object.assign(r, extra);
  r.status = "settled"; r.outcome = final; r.settled_at = now; r.settled_by = by;
}
/** Settle what time and the walks have decided: lapsed holders, ended work bounds, deadlines, ended walks; prune old
 *  settled requests. Mutates the store; true when anything changed. */
export function sweepStore(s: Store, pol: QueuePolicy, now: number): boolean {
  let changed = false;
  for (const r of s.requests) {
    if (r.status === "settled") continue;
    // The holder's own clocks first: a holder that died before the deadline lapsed then, not at the deadline.
    const held = activeAttempt(r);
    if (held) {
      if (now > held.renewed_at + held.grace_renewals * held.renew_every_ms) {
        endAttempt(held, "lapsed", "holder_gone", "sweep:liveness", now); counts.lapsed += 1; changed = true;
      } else if (now >= held.until) {
        endAttempt(held, "expired", "ttl", "sweep:ttl", now); counts.expired += 1; changed = true;
      }
    }
    const a = activeAttempt(r);
    const walk = r.dispatch_id ? deps.dispatchState(r.dispatch_id) : "unknown";
    if (now >= r.deadline) {
      settleRequest(r, "expired", "sweep:deadline", now); counts.expired += 1; changed = true;
      if (a) a.reason = "deadline";
      continue;
    }
    if (walk === "ended") {
      settleRequest(r, "withdrawn", "sweep:walk_ended", now); counts.withdrawn += 1; changed = true;
      if (a) a.reason = "walk_ended";
      continue;
    }
    const status = activeAttempt(r) ? "leased" : "pending";
    if (r.status !== status) { r.status = status; changed = true; }
  }
  const keep = s.requests.filter((r) => !(r.status === "settled" && typeof r.settled_at === "number" && now - r.settled_at > pol.retention_ms));
  if (keep.length !== s.requests.length) { counts.pruned += s.requests.length - keep.length; s.requests = keep; changed = true; }
  return changed;
}

/** A dispatch record's initiator: its recorded `initiator`, else its principal's kind (a key is an operator act,
 *  node-self the system's); null when the record names neither (no record, or one older than the inbound door). */
export function dispatchOriginOf(rec: { initiator?: unknown; principal?: { kind?: unknown } } | undefined | null): RequestOrigin | null {
  if (!rec) return null;
  if (rec.initiator === "system" || rec.initiator === "operator") return rec.initiator;
  const k = rec.principal?.kind;
  return k === "key" ? "operator" : k === "node_self" ? "system" : null;
}

export const goalHashOfRequest = (goal: string): string => createHash("sha256").update(goal.trim()).digest("hex").slice(0, 16);

/** The request as a resolver sees it: what to do, what was tried, what it needs, and by when. */
export function requestView(r: ResolverRequest): Record<string, unknown> {
  return {
    id: r.id, dispatchId: r.dispatch_id, goal: r.goal, shape: r.shape, description: r.description, inputs: r.inputs,
    prior_attempts: r.attempts.filter((a) => a.ended_at !== undefined).map((a) => ({ attempt: a.attempt, outcome: a.outcome ?? null, reason: a.reason ?? null })),
    required: r.required, deadline: new Date(r.deadline).toISOString(), origin: r.origin,
  };
}

// ─── ops ───
export interface EnqueueInput {
  id?: string; dispatch_id: string | null; origin: RequestOrigin; dispatcher: string; goal: string; shape: string;
  description: string; inputs?: Record<string, unknown>; required?: { capabilities?: string[]; scopes?: string[] }; deadline: number;
}
/** Enqueue a request, or RE-ATTACH to this dispatch's request for the same goal and shape (a requeued walk asking
 *  again): an unsettled one is returned as it is; a settled answer not yet delivered is returned once. */
export async function enqueueRequest(inp: EnqueueInput): Promise<{ request: ResolverRequest; attached: boolean } | { unknown: true; reason: string }> {
  const gh = goalHashOfRequest(inp.goal);
  return op<{ request: ResolverRequest; attached: boolean }>((s, _pol, now) => {
    if (inp.dispatch_id) {
      const mine = s.requests.filter((r) => r.dispatch_id === inp.dispatch_id && r.goal_hash === gh && r.shape === inp.shape);
      const open = mine.find((r) => r.status !== "settled");
      if (open) { counts.reattached += 1; return { result: { request: structuredClone(open), attached: true }, changed: false }; }
      // A person's or a holder's terminal answer the walk has not taken yet (a person may answer by solicitationId while
      // goal-host restarts): delivered once.
      const answered = mine.find((r) => (r.outcome === "resolved" || r.outcome === "partial" || r.outcome === "answered" || r.outcome === "declined" || r.outcome === "insufficient_context") && r.delivered_at === undefined);
      if (answered) { answered.delivered_at = now; counts.reattached += 1; return { result: { request: structuredClone(answered), attached: true }, changed: true }; }
    }
    const r: ResolverRequest = {
      id: inp.id ?? randomUUID(), dispatch_id: inp.dispatch_id, origin: inp.origin, dispatcher: inp.dispatcher, goal: inp.goal, goal_hash: gh,
      shape: inp.shape, description: inp.description, inputs: inp.inputs ?? {},
      required: { capabilities: [...(inp.required?.capabilities ?? [])], scopes: [...(inp.required?.scopes ?? [])] },
      created_at: now, deadline: inp.deadline, status: "pending", declined_by: [], attempts: [],
    };
    s.requests.push(r);
    counts.enqueued += 1;
    return { result: { request: structuredClone(r), attached: false }, changed: true };
  });
}

export interface LeaseOffer { capabilities?: string[]; shapes?: string[]; holder_instance?: string | null }
export interface LeasePrincipal { label: string; scopes: readonly string[] }
export type LeaseGrant = { lease_id: string; attempt: number; ttl_ms: number; renew_every_ms: number; request: Record<string, unknown> };
/** requestLease: the earliest-deadline pending request this principal may take, exclusively, or none. */
export async function leaseRequest(who: LeasePrincipal, offer: LeaseOffer): Promise<{ lease: LeaseGrant | null } | { unknown: true; reason: string }> {
  const caps = new Set(offer.capabilities ?? []);
  const shapes = offer.shapes && offer.shapes.length > 0 ? new Set(offer.shapes) : null;
  const scopes = new Set(who.scopes);
  return op<{ lease: LeaseGrant | null }>((s, pol, now) => {
    const candidates = s.requests
      .filter((r) => r.status === "pending"
        && !sameAccount(r.dispatcher, who.label)
        && !r.declined_by.some((d) => sameAccount(d, who.label))
        && (!shapes || shapes.has(r.shape))
        && r.required.capabilities.every((c) => caps.has(c))
        && r.required.scopes.every((c) => scopes.has(c)))
      .sort((a, b) => a.deadline - b.deadline || a.created_at - b.created_at);
    const r = candidates[0];
    if (!r) return { result: { lease: null }, changed: false };
    const a: RequestAttempt = {
      attempt: r.attempts.length + 1, lease_id: randomUUID(), holder: who.label, holder_instance: typeof offer.holder_instance === "string" ? offer.holder_instance.slice(0, 120) : null,
      leased_at: now, renewed_at: now, renew_every_ms: pol.renew_every_ms, grace_renewals: pol.grace_renewals, until: Math.min(now + pol.ttl_ms, r.deadline),
    };
    r.attempts.push(a);
    r.status = "leased";
    counts.leased += 1;
    console.log(`[request-queue] leased request ${r.id} attempt ${a.attempt} to ${who.label} (renew every ${a.renew_every_ms} ms, work bound ${new Date(a.until).toISOString()})`);
    return { result: { lease: { lease_id: a.lease_id, attempt: a.attempt, ttl_ms: a.until - now, renew_every_ms: a.renew_every_ms, request: requestView(r) } }, changed: true };
  });
}

const findAttempt = (s: Store, leaseId: string): { r: ResolverRequest; a: RequestAttempt } | null => {
  for (const r of s.requests) { const a = r.attempts.find((x) => x.lease_id === leaseId); if (a) return { r, a }; }
  return null;
};

export type RenewResult = { renewed: true; ttl_ms: number; until: string; renew_every_ms: number } | { renewed: false; revoked: boolean; reason: string };
/** requestLease_renew: liveness for the holder; a lease that ended (lapsed, the walk ended, the request settled, its
 *  deadline or work bound) answers revoked with the reason, so the holder stops. */
export async function renewLease(who: LeasePrincipal, leaseId: string, attempt: number): Promise<RenewResult | { unknown: true; reason: string }> {
  return op<RenewResult>((s, _pol, now) => {
    const f = findAttempt(s, leaseId);
    if (!f) return { result: { renewed: false, revoked: false, reason: "unknown_lease" }, changed: false };
    if (f.a.attempt !== attempt) return { result: { renewed: false, revoked: true, reason: "stale_attempt" }, changed: false };
    if (f.a.holder !== who.label) return { result: { renewed: false, revoked: false, reason: "not_holder" }, changed: false };
    if (f.a.ended_at !== undefined) return { result: { renewed: false, revoked: true, reason: f.a.reason ?? String(f.a.outcome ?? "ended") }, changed: false };
    f.a.renewed_at = now;
    counts.renewed += 1;
    return { result: { renewed: true, ttl_ms: f.a.until - now, until: new Date(f.a.until).toISOString(), renew_every_ms: f.a.renew_every_ms }, changed: true };
  });
}

export interface LeaseAnswer {
  lease_id: string; attempt: number; outcome: AnswerOutcome; reason?: string; answer?: unknown; evidence?: unknown;
  guidance_used?: unknown; guidance_proposal?: unknown; request_gaps?: unknown;
}
export type AnswerResult =
  | { accepted: true; outcome: AnswerOutcome; request_id: string; request_status: ResolverRequest["status"]; lease_provenance: LeaseProvenance; answer_binding: AnswerBinding }
  | { accepted: false; refused: "duplicate" | "late" | "not_holder" | "unknown_lease"; reason?: string; recorded_outcome?: AttemptOutcome | null };
/** solicitationResponse_write v2: the holder's answer, ONCE per (lease_id, attempt). A repeat is refused duplicate (with
 *  the recorded outcome, so an outbox stops); an answer to a lease that already ended, or to a stale attempt, is late. */
export async function answerLease(who: LeasePrincipal, ans: LeaseAnswer): Promise<AnswerResult | { unknown: true; reason: string }> {
  return op<AnswerResult>((s, _pol, now) => {
    const f = findAttempt(s, ans.lease_id);
    if (!f) { counts.refused_unknown_lease += 1; return { result: { accepted: false, refused: "unknown_lease" }, changed: false }; }
    const { r, a } = f;
    if (a.attempt !== ans.attempt) { counts.refused_late += 1; return { result: { accepted: false, refused: "late", reason: "stale_attempt", recorded_outcome: a.outcome ?? null }, changed: false }; }
    if (a.holder !== who.label) { counts.refused_not_holder += 1; return { result: { accepted: false, refused: "not_holder" }, changed: false }; }
    if (a.ended_at !== undefined) {
      const dup = a.settled_by === "response";
      counts[dup ? "refused_duplicate" : "refused_late"] += 1;
      return { result: { accepted: false, refused: dup ? "duplicate" : "late", reason: a.reason, recorded_outcome: a.outcome ?? null }, changed: false };
    }
    const prov: LeaseProvenance = { request_id: r.id, lease_id: a.lease_id, attempt: a.attempt, dispatch_id: r.dispatch_id, origin: r.origin };
    endAttempt(a, ans.outcome, typeof ans.reason === "string" ? ans.reason.slice(0, 500) : ans.outcome, "response", now);
    const binding: AnswerBinding = { answer_id: randomUUID(), accepted_at: new Date(now).toISOString() };
    a.lease_provenance = prov;
    a.answer_binding = binding;
    for (const k of ["answer", "evidence", "guidance_used", "guidance_proposal", "request_gaps"] as const) if (ans[k] !== undefined) (a as unknown as Record<string, unknown>)[k] = ans[k];
    if (ans.outcome === "resolved" || ans.outcome === "partial") {
      settleRequest(r, ans.outcome, "response", now, { answer: ans.answer, answered_by: who.label, lease_provenance: prov, answer_binding: binding });
    } else {
      if (ans.outcome === "declined" && !r.declined_by.includes(who.label)) r.declined_by.push(who.label);
      r.status = "pending";
    }
    counts.answers_accepted += 1;
    console.log(`[request-queue] request ${r.id} attempt ${a.attempt} answered ${ans.outcome} by ${who.label} (origin ${r.origin})`);
    return { result: { accepted: true, outcome: ans.outcome, request_id: r.id, request_status: r.status, lease_provenance: prov, answer_binding: binding }, changed: true };
  });
}

/** The request as stored now (after a sweep), or null. */
export async function readRequest(id: string): Promise<ResolverRequest | null | { unknown: true; reason: string }> {
  return op((s) => ({ result: (() => { const r = s.requests.find((x) => x.id === id); return r ? structuredClone(r) : null; })(), changed: false }));
}

/** The requests matching every given key (request_id, the lease_id of any attempt, dispatch_id), after a sweep. */
export async function readRequests(q: { request_id?: string; lease_id?: string; dispatch_id?: string }): Promise<ResolverRequest[] | { unknown: true; reason: string }> {
  return op((s) => ({
    result: s.requests
      .filter((r) => (!q.request_id || r.id === q.request_id) && (!q.dispatch_id || r.dispatch_id === q.dispatch_id) && (!q.lease_id || r.attempts.some((a) => a.lease_id === q.lease_id)))
      .map((r) => structuredClone(r)),
    changed: false,
  }));
}
const iso = (t: number | undefined): string | null => (typeof t === "number" && Number.isFinite(t) ? new Date(t).toISOString() : null);
/** THE LEASE RECORD AS SERVED (resolverRequest): ids, origin, every attempt's window and outcome, the provenance and the
 *  answer binding. Never the question, inputs or answer, and holders by principalTag only. */
export function servedRequest(r: ResolverRequest): Record<string, unknown> {
  return {
    request_id: r.id, dispatch_id: r.dispatch_id, origin: r.origin, shape: r.shape, status: r.status, outcome: r.outcome ?? null,
    created_at: iso(r.created_at), deadline: iso(r.deadline), settled_at: iso(r.settled_at), settled_by: r.settled_by ?? null,
    lease_provenance: r.lease_provenance ?? null, answer_binding: r.answer_binding ?? null,
    attempts: r.attempts.map((a) => ({
      attempt: a.attempt, lease_id: a.lease_id, holder_tag: principalTag(a.holder),
      granted_at: iso(a.leased_at), renewed_at: iso(a.renewed_at), live_until: iso(a.renewed_at + a.grace_renewals * a.renew_every_ms),
      expires_at: iso(a.until), ended_at: iso(a.ended_at), outcome: a.outcome ?? null, reason: a.reason ?? null, settled_by: a.settled_by ?? null,
      lease_provenance: a.lease_provenance ?? null, answer_binding: a.answer_binding ?? null,
    })),
  };
}

/** Settle a request from outside a lease (a person's answer by solicitationId, the waiter's end). A request already
 *  settled is left as it is; the answer is the first terminal one. */
export async function settleRequestById(id: string, final: RequestFinal, by: string, extra: { answer?: unknown; answered_by?: string; delivered?: boolean } = {}): Promise<{ settled: boolean; outcome: RequestFinal | null } | { unknown: true; reason: string }> {
  return op<{ settled: boolean; outcome: RequestFinal | null }>((s, _pol, now) => {
    const r = s.requests.find((x) => x.id === id);
    if (!r) return { result: { settled: false, outcome: null }, changed: false };
    // The waiter that ends took whatever settled it: the answer is delivered and is not handed to a re-attaching walk.
    const markDelivered = extra.delivered === true && r.delivered_at === undefined;
    if (markDelivered) r.delivered_at = now;
    if (r.status === "settled") return { result: { settled: false, outcome: r.outcome ?? null }, changed: markDelivered };
    settleRequest(r, final, by, now, { ...(extra.answer !== undefined ? { answer: extra.answer } : {}), ...(extra.answered_by ? { answered_by: extra.answered_by } : {}) });
    return { result: { settled: true, outcome: final }, changed: true };
  });
}

/** The waiter's settlement: whatever `fn` returns (or throws), the request ends settled. `finalOf` maps the waiter's
 *  result to the request's end; a throw settles it "error" and rethrows. */
export async function withRequestSettlement<T>(id: string, fn: () => Promise<T>, finalOf: (r: T) => RequestFinal, extraOf: (r: T) => { answer?: unknown; answered_by?: string } = () => ({})): Promise<T> {
  let res: T;
  try {
    res = await fn();
  } catch (err) {
    counts.settled_on_error += 1;
    await settleRequestById(id, "error", "waiter:exception");
    throw err;
  }
  const done = await settleRequestById(id, finalOf(res), "waiter", { ...extraOf(res), delivered: true });
  if (!isUnknown(done) && done.settled) counts.settled_by_waiter += 1;
  return res;
}

/** The service's interval and boot sweep. */
export async function sweepRequests(): Promise<void> { await op(() => ({ result: null, changed: false })); }
