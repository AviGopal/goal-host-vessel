// THE RESOLVER REQUEST QUEUE'S RULES (src/request-queue.ts), unit-level with an injected clock, policy and dispatch
// reader, against a real store directory (every op reads it fresh and saves it atomically).
//
// Pinned here: one lease per request however many leasers race; revocation is visible on renew; one answer per
// (lease_id, attempt), bound by an answer_id, and late answers refused; never leased to the dispatcher's account nor
// re-offered to an account that declined; a holder that stops renewing frees the lease within its liveness grace, far
// inside its ttl (the landing-lease orphan lesson); every attempt and request ends in a recorded outcome (the
// settlement lesson), the waiter's throw included; the policy is read but clamped to literal bounds; an unreadable store
// abstains and is never overwritten. Controls: a live holder still blocks; an in-bounds policy applies.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as q from "../src/request-queue";

let now = 0;
let policy: Record<string, unknown> | null = null;
let walks = new Map<string, "running" | "ended">();
let dir = "";
let warned: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "request-queue-unit-"));
  q.setRequestQueueRoot(dir);
  now = Date.parse("2026-10-22T12:00:00Z");
  policy = null;
  walks = new Map();
  warned = [];
  q.__setRequestQueueDepsForTests({ now: () => now, readPolicy: async () => policy, dispatchState: (id) => walks.get(id) ?? "unknown" });
  spies.push(spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(" ")); }));
  spies.push(spyOn(console, "log").mockImplementation(() => {}));
});
afterEach(() => {
  q.__setRequestQueueDepsForTests(null);
  q.setRequestQueueRoot(null);
  while (spies.length) spies.pop()!.mockRestore();
});

const DISPATCHER = { label: "key:kid-dispatcher", scopes: ["read", "write"] };
const A = { label: "key:kid-a", scopes: ["read", "write"] };
const B = { label: "key:kid-b", scopes: ["read", "write"] };
const OFFER = { capabilities: ["person_present"] };
const D = q.QUEUE_POLICY_DEFAULTS;

async function enq(dispatchId = "d1", over: Partial<q.EnqueueInput> = {}): Promise<q.ResolverRequest> {
  walks.set(dispatchId, "running");
  const r = await q.enqueueRequest({ dispatch_id: dispatchId, origin: "system", dispatcher: DISPATCHER.label, goal: `goal for ${dispatchId}`, shape: "human_input", description: "question", required: { capabilities: ["person_present"] }, deadline: now + 30 * 60_000, ...over });
  if (q.isUnknown(r)) throw new Error(`enqueue abstained: ${r.reason}`);
  return r.request;
}
function grant(r: Awaited<ReturnType<typeof q.leaseRequest>>): q.LeaseGrant {
  if (q.isUnknown(r) || !r.lease) throw new Error(`no lease: ${JSON.stringify(r)}`);
  return r.lease;
}
async function stored(id: string): Promise<q.ResolverRequest> {
  const r = await q.readRequest(id);
  if (!r || q.isUnknown(r)) throw new Error(`no request ${id}`);
  return r;
}

describe("request queue: exclusivity at the one serialization point", () => {
  it("request-queue two concurrent leasers of one pending request get exactly one lease", async () => {
    await enq();
    // The policy read is an await between an op's read of the store and its decision, as a slow disk makes it live: the
    // window two unserialized leasers would both decide inside.
    q.__setRequestQueueDepsForTests({ now: () => now, readPolicy: async () => { await new Promise((r) => setTimeout(r, 25)); return policy; }, dispatchState: (id) => walks.get(id) ?? "unknown" });
    const [ra, rb] = await Promise.all([q.leaseRequest(A, OFFER), q.leaseRequest(B, OFFER)]);
    const granted = [ra, rb].filter((r) => !q.isUnknown(r) && r.lease !== null);
    expect(granted.length).toBe(1);
  });
});

describe("request queue: revocation is visible on renew", () => {
  it("request-queue the walk ends, and the holder's next renew answers revoked walk_ended and the request settles withdrawn", async () => {
    const r = await enq();
    const l = grant(await q.leaseRequest(A, OFFER));
    expect(await q.renewLease(A, l.lease_id, l.attempt)).toMatchObject({ renewed: true });
    walks.set("d1", "ended");
    now += 1_000;
    expect(await q.renewLease(A, l.lease_id, l.attempt)).toEqual({ renewed: false, revoked: true, reason: "walk_ended" });
    const s = await stored(r.id);
    expect(s.outcome).toBe("withdrawn");
    expect(s.attempts[0]!.outcome).toBe("revoked");
  });
});

describe("request queue: one answer per (lease_id, attempt), bound", () => {
  it("request-queue a second answer on a bound lease is refused duplicate, and the lease record exposes the binding", async () => {
    const r = await enq();
    const l = grant(await q.leaseRequest(A, OFFER));
    const first = await q.answerLease(A, { lease_id: l.lease_id, attempt: l.attempt, outcome: "resolved", answer: "42" });
    expect(first).toMatchObject({ accepted: true, outcome: "resolved" });
    if (q.isUnknown(first) || !first.accepted) throw new Error("not accepted");
    const again = await q.answerLease(A, { lease_id: l.lease_id, attempt: l.attempt, outcome: "resolved", answer: "42" });
    expect(again).toEqual({ accepted: false, refused: "duplicate", reason: "resolved", recorded_outcome: "resolved" });
    const other = await q.answerLease(A, { lease_id: l.lease_id, attempt: l.attempt, outcome: "failed", answer: "changed my mind" });
    expect(other).toMatchObject({ accepted: false, refused: "duplicate" });
    const s = await stored(r.id);
    expect(s.attempts[0]!.answer).toBe("42");
    const served = q.servedRequest(s) as { attempts: Array<Record<string, unknown>>; answer_binding: unknown };
    expect(served.attempts[0]!.answer_binding).toEqual(first.answer_binding);
    expect(Object.keys(first.answer_binding).sort()).toEqual(["accepted_at", "answer_id"]);
    expect(served.answer_binding).toEqual(first.answer_binding);
  });

  it("request-queue an answer after the lease lapsed is refused late", async () => {
    await enq();
    const l = grant(await q.leaseRequest(A, OFFER));
    now += D.grace_renewals * D.renew_every_ms + 1;
    const late = await q.answerLease(A, { lease_id: l.lease_id, attempt: l.attempt, outcome: "resolved", answer: "too late" });
    expect(late).toEqual({ accepted: false, refused: "late", reason: "holder_gone", recorded_outcome: "lapsed" });
  });
});

describe("request queue: accounts", () => {
  it("request-queue is never leased to the dispatcher's own account", async () => {
    await enq();
    expect(await q.leaseRequest(DISPATCHER, OFFER)).toEqual({ lease: null });
    expect(grant(await q.leaseRequest(A, OFFER)).attempt).toBe(1);
  });

  it("request-queue a declined request is not re-offered to the declining account, and the next resolver sees the decline", async () => {
    await enq();
    const l = grant(await q.leaseRequest(A, OFFER));
    expect(await q.answerLease(A, { lease_id: l.lease_id, attempt: 1, outcome: "declined", reason: "not mine" })).toMatchObject({ accepted: true, request_status: "pending" });
    expect(await q.leaseRequest(A, OFFER)).toEqual({ lease: null });
    const lb = grant(await q.leaseRequest(B, OFFER));
    expect(lb.attempt).toBe(2);
    expect(lb.request["prior_attempts"]).toEqual([{ attempt: 1, outcome: "declined", reason: "not mine" }]);
  });
});

describe("request queue: a dead holder frees the lease well before its ttl (lesson 1)", () => {
  it("request-queue a holder that stops renewing is lapsed at its liveness grace, at most a tenth of the ttl, and the request goes to the next resolver", async () => {
    const r = await enq();
    const l = grant(await q.leaseRequest(A, OFFER));
    const grantedAt = now;
    now += l.renew_every_ms * D.grace_renewals + 1; // the holder's process died at the grant: no renewal ever came
    const lb = grant(await q.leaseRequest(B, OFFER));
    expect(lb.attempt).toBe(2);
    expect(now - grantedAt).toBeLessThanOrEqual(l.ttl_ms / 10);
    const s = await stored(r.id);
    expect(s.attempts[0]).toMatchObject({ outcome: "lapsed", reason: "holder_gone" });
    expect(lb.request["prior_attempts"]).toEqual([{ attempt: 1, outcome: "lapsed", reason: "holder_gone" }]);
  });

  it("request-queue CONTROL: a holder that keeps renewing still holds it", async () => {
    await enq();
    const l = grant(await q.leaseRequest(A, OFFER));
    for (let i = 0; i < 5; i++) {
      now += l.renew_every_ms - 1;
      expect(await q.renewLease(A, l.lease_id, l.attempt)).toMatchObject({ renewed: true });
    }
    expect(await q.leaseRequest(B, OFFER)).toEqual({ lease: null });
  });
});

describe("request queue: every request settles (lesson 2)", () => {
  it("request-queue every attempt and every request ends in a recorded outcome: answer, lapse, walk end, deadline", async () => {
    const answered = await enq("d-answer");
    const la = grant(await q.leaseRequest(A, OFFER));
    await q.answerLease(A, { lease_id: la.lease_id, attempt: la.attempt, outcome: "resolved", answer: "x" });
    const lapsedThenExpired = await enq("d-lapse", { deadline: now + 10 * 60_000 });
    grant(await q.leaseRequest(A, OFFER));
    const ended = await enq("d-ended");
    grant(await q.leaseRequest(B, OFFER));
    walks.set("d-ended", "ended");
    const untouched = await enq("d-deadline", { deadline: now + 5 * 60_000 });
    now += 11 * 60_000;
    await q.sweepRequests();
    const all = await Promise.all([answered, lapsedThenExpired, ended, untouched].map((r) => stored(r.id)));
    expect(all.map((r) => [r.status, r.outcome])).toEqual([["settled", "resolved"], ["settled", "expired"], ["settled", "withdrawn"], ["settled", "expired"]]);
    for (const r of all) for (const a of r.attempts) expect(typeof a.outcome).toBe("string");
    expect(all[1]!.attempts[0]!.outcome).toBe("lapsed");
  });

  it("request-queue a waiter that throws settles its request error at once, not at its deadline", async () => {
    const r = await enq();
    await expect(q.withRequestSettlement(r.id, async () => { throw new Error("walk blew up"); }, () => "timeout")).rejects.toThrow("walk blew up");
    const s = await stored(r.id);
    expect([s.status, s.outcome, s.settled_by]).toEqual(["settled", "error", "waiter:exception"]);
  });

  it("request-queue a waiter that ends settles its request with its own outcome and an open lease is revoked request_settled", async () => {
    const r = await enq();
    const l = grant(await q.leaseRequest(A, OFFER));
    await q.withRequestSettlement(r.id, async () => "timeout" as const, (x) => x);
    const s = await stored(r.id);
    expect([s.outcome, s.attempts[0]!.outcome, s.attempts[0]!.reason]).toEqual(["timeout", "revoked", "request_settled"]);
    expect(await q.renewLease(A, l.lease_id, l.attempt)).toEqual({ renewed: false, revoked: true, reason: "request_settled" });
  });
});

describe("request queue: the policy is read and clamped to literal bounds", () => {
  it("request-queue an out-of-bounds policy is ignored for the defaults, each field logged", async () => {
    policy = { ttl_ms: 10 * 3600_000, renew_every_ms: 0, grace_renewals: 9, retention_ms: 60_000 };
    await enq();
    const l = grant(await q.leaseRequest(A, OFFER));
    expect([l.ttl_ms, l.renew_every_ms]).toEqual([D.ttl_ms, D.renew_every_ms]);
    for (const k of ["ttl_ms", "renew_every_ms", "grace_renewals", "retention_ms"]) expect(warned.some((w) => w.includes(`requestQueuePolicy.${k}=`))).toBe(true);
    expect(q.clampQueuePolicy(policy, () => {})).toEqual({ ...D });
  });

  it("request-queue renew_every_ms never exceeds a tenth of the ttl in force", () => {
    const p = q.clampQueuePolicy({ ttl_ms: 60_000, renew_every_ms: 20_000 }, () => {});
    expect(p.ttl_ms).toBe(60_000);
    expect(p.renew_every_ms).toBeLessThanOrEqual(6_000);
  });

  it("request-queue CONTROL: an in-bounds policy applies", async () => {
    policy = { renew_every_ms: 5_000, grace_renewals: 3 };
    await enq();
    const l = grant(await q.leaseRequest(A, OFFER));
    expect(l.renew_every_ms).toBe(5_000);
    expect(warned.filter((w) => w.includes("requestQueuePolicy"))).toEqual([]);
  });
});

describe("request queue: origin and abstention", () => {
  it("request-queue a dispatch's origin is its recorded initiator, else its principal's kind, else unknown", () => {
    expect(q.dispatchOriginOf({ principal: { kind: "key" } })).toBe("operator");
    expect(q.dispatchOriginOf({ principal: { kind: "node_self" } })).toBe("system");
    expect(q.dispatchOriginOf({ initiator: "operator", principal: { kind: "node_self" } })).toBe("operator");
    expect(q.dispatchOriginOf({})).toBeNull();
    expect(q.dispatchOriginOf(undefined)).toBeNull();
  });

  it("request-queue a store that does not parse abstains unknown and is left as it is", async () => {
    const p = q.requestQueuePath()!;
    writeFileSync(p, "{ not json");
    const r = await q.leaseRequest(A, OFFER);
    expect(q.isUnknown(r)).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("{ not json");
  });

  it("request-queue with no store on this process every op abstains", async () => {
    q.setRequestQueueRoot(null);
    expect(q.isUnknown(await q.leaseRequest(A, OFFER))).toBe(true);
  });
});
