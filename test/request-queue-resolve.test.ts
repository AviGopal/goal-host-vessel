// THE RESOLVER REQUEST QUEUE THROUGH goal-host's OWN /resolve HANDLER (src/index.ts handleResolve, src/request-queue.ts).
//
// THE ROW'S FALSIFIER: a request enqueued before a vessel restart is still pending after it and is delivered to its
// resolver. Two real processes: a child opens the store, enqueues and exits; this process (fresh module state, the
// restarted vessel) leases it through requestLease with an identity-validated key and answers it. CONTROL: the
// completed request is not redelivered, here or in a third process (a second restart).
//
// Also pinned: requestLease is a gated write (an unauthenticated lease is 401 and grants nothing); the walk's own
// solicitation (solicitHumanInput) is a durable request an agent offering a present person can lease; its origin is the
// dispatch's recorded initiator; the v2 answer is recorded with goal-host-stamped lease provenance
// {request_id, lease_id, attempt, dispatch_id, origin} and answer binding on the lease record (served by
// resolverRequest) and on the dispatch record (resolverAnswers[], served by goalWalkState), and a second answer on the
// bound lease is refused; the dispatcher's own key gets no lease.
//
// Identity is a globalThis.fetch stub (the harness test/inbound-auth-gate.test.ts uses); so is the human_input producer.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDENTITY = "http://127.0.0.1:59161";
const PRODUCER = "http://127.0.0.1:59162";
const NODE_KEY = "rq-test-node-key";
const PLAIN_KEY = "rq-test-plain-key";
const OPERATOR_KEY = "rq-test-operator-key";

process.env.LLM_VESSEL_ENDPOINT ??= "http://127.0.0.1:65535";
// Importing index.ts starts its 5 s memory-dump writer: point it at scratch, never the live dump.
process.env["MEM_DUMP_PATH"] = join(mkdtempSync(join(tmpdir(), "request-queue-memdump-")), "mem-dump.json");
process.env["GOAL_HOST_DISPATCH_STORE_PATH"] = join(mkdtempSync(join(tmpdir(), "request-queue-resolve-store-")), "goal-host-dispatches.json");
const gh = await import("../src/index");
const rq = await import("../src/request-queue");
const ia = await import("../src/inbound-auth");
const { __resetCredentialCacheForTests } = await import("../src/caller-credential");
const { handleResolve, markInboundRemote, solicitHumanInput, __inboundAuthStateForTests } = gh;
const { executionStore } = __inboundAuthStateForTests;

const CHILD = join(import.meta.dir, "fixtures", "request-queue-child.ts");
const realFetch = globalThis.fetch;
const spies: Array<ReturnType<typeof spyOn>> = [];
const saved: Record<string, string | undefined> = {};
let dir = "";
let posted = 0;

beforeEach(() => {
  for (const k of ["IDENTITY_VESSEL_URL", "METABOB_API_KEY"]) saved[k] = process.env[k];
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  process.env["METABOB_API_KEY"] = NODE_KEY;
  __resetCredentialCacheForTests();
  ia.__resetInboundAuthForTests();
  dir = mkdtempSync(join(tmpdir(), "request-queue-resolve-"));
  rq.setRequestQueueRoot(dir);
  posted = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = String(init?.body ?? "");
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      const key = String((JSON.parse(body || "{}") as { impulse?: { pointer?: { apiKey?: string } } })?.impulse?.pointer?.apiKey ?? "");
      const scopes = key === PLAIN_KEY ? ["read", "write"] : key === OPERATOR_KEY ? ["read", "write", "operator:direct"] : null;
      if (!scopes) return Response.json({ success: false, error: "invalid" }, { status: 401 });
      return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: `kid-${key.split("-")[2]}`, scopes } });
    }
    if (body.includes('"vesselCapability"') && body.includes('"human_input"')) {
      return Response.json({ content: { vessels: [{ endpoint: PRODUCER, resolve_timeout_ms: 60_000 }] } });
    }
    if (u.startsWith(PRODUCER)) { posted += 1; return Response.json({ ok: true }); }
    return Response.json({ error: "no network in this test" }, { status: 503 });
  }) as unknown as typeof fetch;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) spies.push(spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  while (spies.length) spies.pop()!.mockRestore();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rq.setRequestQueueRoot(null);
});
afterAll(() => { executionStore.clear(); });

function resolve(payload: Record<string, unknown>, authorization?: string): Promise<Response> {
  const req = new Request("http://goal-host.test/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "request-queue-probe/1", ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(payload),
  });
  return handleResolve(markInboundRemote(req, "127.0.0.1"));
}
async function json(r: Response): Promise<{ status: number; j: Record<string, any> }> { return { status: r.status, j: (await r.json()) as Record<string, any> }; }
function child(...args: string[]): { code: number; out: Record<string, any> | null } {
  const p = Bun.spawnSync([process.execPath, CHILD, ...args], { stdout: "pipe", stderr: "pipe" });
  const lines = new TextDecoder().decode(p.stdout).trim().split("\n").filter(Boolean);
  let out: Record<string, any> | null = null;
  try { out = JSON.parse(lines[lines.length - 1] ?? "null"); } catch { out = null; }
  return { code: p.exitCode ?? -1, out };
}
const running = (id: string, principal: { kind: "node_self" | "key"; label: string; operator: boolean }, initiator: "system" | "operator") =>
  executionStore.set(id, { dispatchId: id, startedAt: Date.now(), status: "running", goal: "fixture walk", reached: null, principal, initiator } as never);
const LEASE = (caps = ["person_present"]) => ({ type: "requestLease", capabilities: caps });

describe("request queue: the row's falsifier", () => {
  it("request-queue a request enqueued before a vessel restart is still pending after it and is delivered to its resolver; completed, it is not redelivered", async () => {
    const D = "rq-falsifier-dispatch";
    const enq = child("enqueue", dir, D, "node-self", "system");
    expect(enq.code).toBe(0);
    const id = enq.out?.request?.id as string;
    expect(typeof id).toBe("string");
    running(D, { kind: "node_self", label: "node-self", operator: false }, "system");

    const l = await json(await resolve(LEASE(), `ApiKey ${PLAIN_KEY}`));
    expect(l.status).toBe(200);
    expect(l.j.body?.lease?.request?.id).toBe(id);
    expect(l.j.body?.lease?.request?.dispatchId).toBe(D);
    const lease = l.j.body.lease as { lease_id: string; attempt: number };

    const a = await json(await resolve({ type: "solicitationResponse_write", lease_id: lease.lease_id, attempt: lease.attempt, outcome: "resolved", answer: "the answer" }, `ApiKey ${PLAIN_KEY}`));
    expect(a.j.body?.accepted).toBe(true);

    // CONTROL: completed, it is not redelivered: not here, not to another key, not after a second restart.
    expect((await json(await resolve(LEASE(), `ApiKey ${PLAIN_KEY}`))).j.body).toEqual({ lease: null });
    expect((await json(await resolve(LEASE(), `ApiKey ${OPERATOR_KEY}`))).j.body).toEqual({ lease: null });
    const again = child("lease", dir, "key:kid-other");
    expect(again.code).toBe(0);
    expect(again.out).toEqual({ lease: null });
  });
});

describe("request queue: a person's answer across the restart", () => {
  it("request-queue a person answering by solicitationId after the restart settles the durable request, and the requeued walk re-attaches and takes it with no second card", async () => {
    const D = "rq-human-dispatch";
    const enq = child("enqueue", dir, D, "node-self", "system");
    expect(enq.code).toBe(0);
    const id = enq.out?.request?.id as string;
    running(D, { kind: "node_self", label: "node-self", operator: false }, "system");
    const v1 = await json(await resolve({ type: "solicitationResponse_write", solicitationId: id, outcome: "answered", answer: "the person's answer" }, `ApiKey ${PLAIN_KEY}`));
    expect([v1.status, v1.j]).toEqual([200, { resolved: true, shape: "solicitationResponse_write", body: { solicitationId: id, outcome: "answered" } }]);
    const sol = await solicitHumanInput("request-queue falsifier goal", "evidence", D);
    expect([sol?.solicitationId, sol?.outcome, sol?.answer, sol?.answeredBy]).toEqual([id, "answered", "the person's answer", "key:kid-plain"]);
    expect(posted).toBe(0);
    // The lease record shows the request settled by the person's answer.
    const again = (await json(await resolve({ type: "resolverRequest", request_id: id }))).j.body.requests[0];
    expect(again.outcome).toBe("answered");
  });
});

describe("request queue: the door", () => {
  it("request-queue an unauthenticated requestLease is refused 401 and grants nothing", async () => {
    const enq = child("enqueue", dir, "rq-door-dispatch", "node-self", "system");
    expect(enq.code).toBe(0);
    running("rq-door-dispatch", { kind: "node_self", label: "node-self", operator: false }, "system");
    expect((await resolve(LEASE())).status).toBe(401);
    const s = await rq.readRequest(enq.out?.request?.id);
    expect((s as { status?: string }).status).toBe("pending");
  });
});

describe("request queue: a walk's solicitation is a durable, leasable request with server-stamped provenance", () => {
  it("request-queue an operator dispatch's solicitation records origin operator; the v2 answer carries all five provenance fields on the lease record and the dispatch record, bound by answer_id; a second answer is refused", async () => {
    const D = "rq-operator-dispatch";
    running(D, { kind: "key", label: "key:kid-operator", operator: true }, "operator");
    const waiting = solicitHumanInput("request-queue provenance goal", "| # | approach tried | outcome |", D);

    let reqs: Array<Record<string, any>> = [];
    for (let i = 0; i < 50 && reqs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      reqs = (await json(await resolve({ type: "resolverRequest", dispatch_id: D }))).j.body?.requests ?? [];
    }
    expect(reqs.length).toBe(1);
    expect(reqs[0]!.origin).toBe("operator");
    expect(posted).toBe(1);

    // The dispatcher's own key is never handed its own request; an agent offering a present person is.
    expect((await json(await resolve(LEASE(), `ApiKey ${OPERATOR_KEY}`))).j.body).toEqual({ lease: null });
    expect((await json(await resolve(LEASE([]), `ApiKey ${PLAIN_KEY}`))).j.body).toEqual({ lease: null });
    const l = (await json(await resolve(LEASE(), `ApiKey ${PLAIN_KEY}`))).j.body.lease as { lease_id: string; attempt: number; request: Record<string, any> };
    expect(l.request.origin).toBe("operator");

    const a = await json(await resolve({ type: "solicitationResponse_write", lease_id: l.lease_id, attempt: l.attempt, outcome: "resolved", answer: "use the second approach" }, `ApiKey ${PLAIN_KEY}`));
    expect(a.j.body.accepted).toBe(true);
    const prov = a.j.body.lease_provenance;
    expect(prov).toEqual({ request_id: reqs[0]!.request_id, lease_id: l.lease_id, attempt: l.attempt, dispatch_id: D, origin: "operator" });
    const binding = a.j.body.answer_binding;
    expect(Object.keys(binding).sort()).toEqual(["accepted_at", "answer_id"]);

    // One answer per lease: a second is refused duplicate.
    const dup = await json(await resolve({ type: "solicitationResponse_write", lease_id: l.lease_id, attempt: l.attempt, outcome: "resolved", answer: "a different answer" }, `ApiKey ${PLAIN_KEY}`));
    expect([dup.status, dup.j.body.refused]).toEqual([409, "duplicate"]);

    // The walk takes the answer with its provenance.
    const sol = await waiting;
    expect(sol?.outcome).toBe("answered");
    expect(sol?.answer).toBe("use the second approach");
    expect(sol?.leaseProvenance).toEqual(prov);

    // The lease record, read at use time (open read): ids, origin, the window, the provenance and the binding.
    const rec = (await json(await resolve({ type: "resolverRequest", lease_id: l.lease_id }))).j.body.requests[0];
    expect(rec.origin).toBe("operator");
    expect(rec.lease_provenance).toEqual(prov);
    expect(rec.answer_binding).toEqual(binding);
    const att = rec.attempts[0];
    expect(att).toMatchObject({ attempt: l.attempt, lease_id: l.lease_id, outcome: "resolved", lease_provenance: prov, answer_binding: binding });
    expect(typeof att.granted_at).toBe("string");
    expect(typeof att.expires_at).toBe("string");
    expect(typeof att.ended_at).toBe("string");
    expect(JSON.stringify(rec)).not.toContain("kid-plain");

    // Downstream: the dispatch record carries it, echoing the bound answer_id, and goalWalkState serves it.
    const answers = (executionStore.get(D) as { resolverAnswers?: Array<Record<string, any>> }).resolverAnswers ?? [];
    expect(answers.length).toBe(1);
    expect(answers[0]!.lease_provenance).toEqual(prov);
    expect(answers[0]!.answer_id).toBe(binding.answer_id);
    const ws = (await json(await resolve({ type: "goalWalkState", dispatchId: D }))).j.body;
    expect(ws.resolverAnswers?.[0]?.answer_id).toBe(binding.answer_id);
  }, 20_000);

  it("request-queue a system dispatch's solicitation records origin system", async () => {
    const D = "rq-system-dispatch";
    running(D, { kind: "node_self", label: "node-self:in-process", operator: false }, "system");
    const waiting = solicitHumanInput("request-queue system goal", "evidence", D);
    let reqs: Array<Record<string, any>> = [];
    for (let i = 0; i < 50 && reqs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      reqs = (await json(await resolve({ type: "resolverRequest", dispatch_id: D }))).j.body?.requests ?? [];
    }
    expect(reqs[0]?.origin).toBe("system");
    const l = (await json(await resolve(LEASE(), `ApiKey ${PLAIN_KEY}`))).j.body.lease as { lease_id: string; attempt: number };
    const a = await json(await resolve({ type: "solicitationResponse_write", lease_id: l.lease_id, attempt: l.attempt, outcome: "resolved", answer: "ok" }, `ApiKey ${PLAIN_KEY}`));
    expect(a.j.body.lease_provenance.origin).toBe("system");
    await waiting;
  }, 20_000);
});
