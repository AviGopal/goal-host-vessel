// THE INBOUND DOOR (operator security review, 2026-10-19).
//
// Measured at the parent: POST /run-goal and POST /resolve authenticated nobody. Any caller that reached the port
// started a walk, queued an impulse into a running walk (which then counted as the walk's own production), answered or
// extended a pending solicitation, or started a judge replay; and a body `operator` field made the dispatch
// operator-originated. src/inbound-auth.ts is the door.
//
// CONTRACT pinned here (identity is a globalThis.fetch stub; any other outbound call is recorded, and a refused request
// must make none):
//   - Unauthenticated, forged, wrong-scheme and identity-unreachable requests to /run-goal and to every gated /resolve
//     type are refused 401 and change NOTHING: no dispatch record, no queued impulse, no solicitation answered or
//     extended, no outbound call. Each refusal is logged with route, shape and a caller hint, and counted by caller.
//   - The body's `operator` carries no authority: only a credential with "operator:direct" (or "admin") does; the
//     node's own key and goal-host's own in-process self-calls never do.
//   - Controls: a keyed request passes the door; a keyed injection lands attributed to its caller, not the walk;
//     the read types stay open.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";

// A loopback literal: the credential module sends keys over plain http only to private hosts.
const IDENTITY = "http://127.0.0.1:59151";
const NODE_KEY = "inbound-auth-node-key-fixture";
const PLAIN_KEY = "inbound-auth-plain-key-fixture";
const OPERATOR_KEY = "inbound-auth-operator-key-fixture";
const ADMIN_KEY = "inbound-auth-admin-key-fixture";
const FORGED_KEY = "inbound-auth-forged-key-fixture";

// src/index.ts guards its HTTP boot behind import.meta.main and makes its LLM port on first use; the endpoint is still set
// first (no connection is opened), then dynamic-import (as test/authoritative-root.test.ts does).
process.env.LLM_VESSEL_ENDPOINT ??= "http://127.0.0.1:65535";
const gh = await import("../src/index");
const ia = await import("../src/inbound-auth");
const { handleRunGoal, handleResolve, executionStore, injectedPoolImpulses, pendingSolicitations } = gh;
const { __resetCredentialCacheForTests } = await import("../src/caller-credential");

const realFetch = globalThis.fetch;
let identityMode: "up" | "down" = "up";
let outbound: string[] = [];
let warned: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["IDENTITY_VESSEL_URL", "METABOB_API_KEY"]) saved[k] = process.env[k];
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  process.env["METABOB_API_KEY"] = NODE_KEY;
  identityMode = "up";
  outbound = [];
  warned = [];
  __resetCredentialCacheForTests();
  ia.__resetInboundAuthForTests();
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      if (identityMode === "down") throw new TypeError("Unable to connect");
      const key = String((JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: { apiKey?: string } } })?.impulse?.pointer?.apiKey ?? "");
      const scopes = key === PLAIN_KEY ? ["read", "write"] : key === OPERATOR_KEY ? ["read", "write", "operator:direct"] : key === ADMIN_KEY ? ["admin"] : null;
      if (!scopes) return Response.json({ success: false, error: "invalid" }, { status: 401 });
      return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: `kid-${key.split("-")[2]}`, scopes } });
    }
    outbound.push(u);
    return Response.json({ error: "no network in this test" }, { status: 503 });
  }) as unknown as typeof fetch;
  spies.push(spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(" ")); }));
  for (const m of ["log", "info", "error", "debug"] as const) spies.push(spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  while (spies.length) spies.pop()!.mockRestore();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const UA = "inbound-auth-probe/1";
const req = (path: string, body: unknown, auth?: string, raw?: string) => new Request(`http://goal-host.test${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "User-Agent": UA, ...(auth ? { Authorization: auth } : {}) },
  body: raw ?? JSON.stringify(body),
});
const runGoal = (body: unknown, auth?: string, raw?: string) => handleRunGoal(req("/run-goal", body, auth, raw), "198.51.100.4");
const resolve = (pointer: Record<string, unknown>, auth?: string) => handleResolve(req("/resolve", { impulse: { pointer } }, auth), "198.51.100.4");

const RUNNING = "inbound-auth-running-dispatch";
const SOLICITATION = "inbound-auth-pending-solicitation";
function seedFixtures(): { deadlineAt: number } {
  executionStore.set(RUNNING, { dispatchId: RUNNING, startedAt: Date.now(), status: "running", goal: "inbound-auth fixture walk", reached: null } as never);
  injectedPoolImpulses.delete(RUNNING);
  const deadlineAt = Date.now() + 30_000;
  pendingSolicitations.set(SOLICITATION, { solicitationId: SOLICITATION, dispatchId: RUNNING, goal: "inbound-auth fixture", createdAt: Date.now(), deadlineAt, maxDeadlineAt: deadlineAt + 600_000, outcome: "pending", composing: false });
  return { deadlineAt };
}

const GATED_POINTERS: Array<Record<string, unknown>> = [
  { type: "goal_execution", goal: "inbound-auth fixture goal" },
  { type: "activity_execution", goal: "inbound-auth fixture goal" },
  { type: "goalDispatchAsync", goal: "inbound-auth fixture goal", operator: "inbound-auth-claimed" },
  { type: "goal_dispatch_async", goal: "inbound-auth fixture goal" },
  { type: "verdictCorpusRun" },
  { type: "poolImpulse_write", dispatchId: RUNNING, shape: "inboundAuthInjected", content: { injected: true } },
  { type: "solicitationResponse_write", solicitationId: SOLICITATION, outcome: "answered", answer: "injected" },
  { type: "solicitationHeartbeat_write", solicitationId: SOLICITATION },
];

describe("the inbound door refuses and changes nothing", () => {
  it("inbound-auth an unauthenticated /run-goal is 401, records no dispatch, calls nothing, and is logged and counted", async () => {
    const before = executionStore.size;
    const r = await runGoal({ goal: "inbound-auth fixture goal", operator: "inbound-auth-claimed", targetTemplateId: "fixture:template" });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code?: string }).code).toBe("caller_credential_required");
    expect(executionStore.size).toBe(before);
    expect(outbound).toEqual([]);
    const line = warned.find((l) => l.includes("inbound-auth REFUSED route=/run-goal shape=run-goal"));
    expect(line).toBeDefined();
    expect(line).toContain("template=fixture:template");
    expect(line).toContain("ua=inbound-auth-probe/1");
    expect(line).toContain("remote=198.51.100.4");
    const counters = ia.inboundAuthCounters();
    expect(counters.refused_total).toBe(1);
    expect(Object.values(counters.by_caller)).toEqual([1]);
    expect(Object.keys(counters.by_caller)[0]).toContain("ua=inbound-auth-probe/1");
  });

  it("inbound-auth forged, Bearer and empty credentials are 401 and record nothing", async () => {
    const before = executionStore.size;
    for (const auth of [`ApiKey ${FORGED_KEY}`, `Bearer ${PLAIN_KEY}`, "ApiKey"]) {
      expect((await runGoal({ goal: "inbound-auth fixture goal" }, auth)).status).toBe(401);
    }
    expect(executionStore.size).toBe(before);
    expect(ia.inboundAuthCounters().refused_total).toBe(3);
  });

  it("inbound-auth an unauthenticated malformed body is refused 401 before it is read as a goal", async () => {
    expect((await runGoal(null, undefined, "{not json")).status).toBe(401);
  });

  it("inbound-auth identity unreachable refuses a key it has not validated (fail closed)", async () => {
    identityMode = "down";
    const before = executionStore.size;
    expect((await runGoal({ goal: "inbound-auth fixture goal" }, `ApiKey ${PLAIN_KEY}`)).status).toBe(401);
    expect(executionStore.size).toBe(before);
  });

  for (const p of GATED_POINTERS) {
    it(`inbound-auth an unauthenticated /resolve ${String(p.type)} is 401 and changes nothing`, async () => {
      const { deadlineAt } = seedFixtures();
      const before = executionStore.size;
      const r = await resolve(p);
      expect(r.status).toBe(401);
      expect(executionStore.size).toBe(before);
      expect(injectedPoolImpulses.has(RUNNING)).toBe(false);
      const sol = pendingSolicitations.get(SOLICITATION)!;
      expect(sol.outcome).toBe("pending");
      expect(sol.deadlineAt).toBe(deadlineAt);
      expect(outbound).toEqual([]);
      expect(warned.some((l) => l.includes(`inbound-auth REFUSED route=/resolve shape=${String(p.type)}`))).toBe(true);
      expect(ia.inboundAuthCounters().refused_total).toBe(1);
    });
  }
});

describe("operator authority comes from the credential, never the body", () => {
  const cred = (scopes: string[], keyId = "k") => ({ authenticated: true, scopes, keyId });
  it("inbound-auth a body operator is only a label for the node key, a plain key and goal-host itself", () => {
    expect(ia.operatorAuthority("claimed", ia.principalOf(cred(["read", "write"])))).toBeUndefined();
    expect(ia.operatorAuthority("claimed", ia.SELF_PRINCIPAL)).toBeUndefined();
    expect(ia.SELF_PRINCIPAL.operator).toBe(false);
    expect(ia.SELF_PRINCIPAL.kind).toBe("node_self");
  });
  it("inbound-auth operator:direct or admin make the label the dispatch's operator", () => {
    expect(ia.operatorAuthority("op", ia.principalOf(cred(["read", "operator:direct"])))).toBe("op");
    expect(ia.operatorAuthority("op", ia.principalOf(cred(["admin"])))).toBe("op");
  });
  it("inbound-auth the node's own key, validated locally, is never an operator", async () => {
    const { identityCredential } = await import("../src/caller-credential");
    const p = ia.principalOf(await identityCredential(`ApiKey ${NODE_KEY}`));
    expect(p.kind).toBe("node_self");
    expect(ia.operatorAuthority("claimed", p)).toBeUndefined();
  });
});

describe("controls: a keyed request passes the door", () => {
  it("inbound-auth a keyed /run-goal passes the door (an empty body then fails its own validation, 400)", async () => {
    for (const auth of [`ApiKey ${NODE_KEY}`, `ApiKey ${PLAIN_KEY}`]) {
      const r = await runGoal({}, auth);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error?: string }).error).toBe("goal or targetTemplateId is required");
    }
    expect(ia.inboundAuthCounters().refused_total).toBe(0);
  });

  it("inbound-auth a keyed poolImpulse_write is queued attributed to its caller, never to the walk", async () => {
    seedFixtures();
    const r = await resolve({ type: "poolImpulse_write", dispatchId: RUNNING, shape: "inboundAuthInjected", content: { ok: 1 } }, `ApiKey ${PLAIN_KEY}`);
    expect(r.status).toBe(200);
    expect(injectedPoolImpulses.get(RUNNING)?.[0]?.producedBy).toBe("key:kid-plain");
    await resolve({ type: "poolImpulse_write", dispatchId: RUNNING, shape: "inboundAuthInjected2", content: { ok: 2 } }, `ApiKey ${NODE_KEY}`);
    expect(injectedPoolImpulses.get(RUNNING)?.[1]?.producedBy).toBe("node-self");
    injectedPoolImpulses.delete(RUNNING);
  });

  it("inbound-auth a keyed solicitationResponse_write answers and records who answered", async () => {
    seedFixtures();
    const r = await resolve({ type: "solicitationResponse_write", solicitationId: SOLICITATION, outcome: "answered", answer: "a" }, `ApiKey ${PLAIN_KEY}`);
    expect(r.status).toBe(200);
    const sol = pendingSolicitations.get(SOLICITATION)!;
    expect(sol.outcome).toBe("answered");
    expect(sol.answeredBy).toBe("key:kid-plain");
    pendingSolicitations.delete(SOLICITATION);
  });

  it("inbound-auth the read types stay open", async () => {
    const r = await resolve({ type: "activeDispatches" });
    expect(r.status).toBe(200);
    expect(ia.inboundAuthCounters().refused_total).toBe(0);
  });
});

describe("the door is wired where it must be (source pins on index.ts)", () => {
  const src = readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8");
  const door = src.indexOf("async function runGoalDoor(");
  it("inbound-auth /run-goal authenticates before the spend-rate window and before any dispatch record", () => {
    expect(door).toBeGreaterThan(0);
    const auth = src.indexOf("authenticateInbound(req.headers, { route: \"/run-goal\"", door);
    expect(auth).toBeGreaterThan(door);
    expect(auth).toBeLessThan(src.indexOf("await dispatchRateDecision(rawGoal)", door));
    expect(auth).toBeLessThan(src.indexOf("executionStore.set(", door));
    expect(src).toContain("const operator = operatorAuthority(operatorLabel, principal);");
  });
  it("inbound-auth goal-host's self-calls run in process as the node's own identity, not over HTTP", () => {
    expect(src).not.toContain('"http://127.0.0.1:" + PORT + "/run-goal"');
    expect(src).not.toMatch(/fetch\(`\$\{GOAL_HOST_ENDPOINT\}\/run-goal`/);
    expect(src.match(/SELF_PRINCIPAL\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(src).toContain("setInProcessRunGoal((b) => runGoalAs(b, SELF_PRINCIPAL));");
  });
  it("inbound-auth /health carries the refusal counters", () => {
    expect(src).toContain("inbound_auth: inboundAuthCounters(),");
  });
});
