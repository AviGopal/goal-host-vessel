// CONTROL for the resolver request queue (src/request-queue.ts): the existing solicitation writes by solicitationId
// answer exactly as they did. A live pending solicitation is answered and extended with the same response bodies and the
// same effect on the waiter's record; an unknown id is the same 404 on a process with no request store. This file
// imports nothing the queue added, so it runs unchanged on the parent.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDENTITY = "http://127.0.0.1:59171";
const PLAIN_KEY = "inbound-auth-plain-key-fixture";

process.env.LLM_VESSEL_ENDPOINT ??= "http://127.0.0.1:65535";
// Importing index.ts starts its 5 s memory-dump writer: point it at scratch, never the live dump.
process.env["MEM_DUMP_PATH"] = join(mkdtempSync(join(tmpdir(), "request-queue-memdump-")), "mem-dump.json");
process.env["GOAL_HOST_DISPATCH_STORE_PATH"] = join(mkdtempSync(join(tmpdir(), "solicitation-v1-store-")), "goal-host-dispatches.json");
const gh = await import("../src/index");
const ia = await import("../src/inbound-auth");
const { __resetCredentialCacheForTests } = await import("../src/caller-credential");
const { handleResolve, markInboundRemote, __inboundAuthStateForTests } = gh;
const { pendingSolicitations } = __inboundAuthStateForTests;

const realFetch = globalThis.fetch;
const spies: Array<ReturnType<typeof spyOn>> = [];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved["IDENTITY_VESSEL_URL"] = process.env["IDENTITY_VESSEL_URL"];
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  __resetCredentialCacheForTests();
  ia.__resetInboundAuthForTests();
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      const key = String((JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: { apiKey?: string } } })?.impulse?.pointer?.apiKey ?? "");
      if (key !== PLAIN_KEY) return Response.json({ success: false }, { status: 401 });
      return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "kid-plain", scopes: ["read", "write"] } });
    }
    return Response.json({ error: "no network in this test" }, { status: 503 });
  }) as unknown as typeof fetch;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) spies.push(spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  while (spies.length) spies.pop()!.mockRestore();
  if (saved["IDENTITY_VESSEL_URL"] === undefined) delete process.env["IDENTITY_VESSEL_URL"]; else process.env["IDENTITY_VESSEL_URL"] = saved["IDENTITY_VESSEL_URL"];
  pendingSolicitations.clear();
});
const resolve = (payload: Record<string, unknown>) => handleResolve(markInboundRemote(new Request("http://goal-host.test/resolve", {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${PLAIN_KEY}` }, body: JSON.stringify(payload),
}), "127.0.0.1"));
const pend = (sid: string) => {
  const now = Date.now();
  pendingSolicitations.set(sid, { solicitationId: sid, dispatchId: "sv1-dispatch", goal: "fixture", createdAt: now, deadlineAt: now + 60_000, maxDeadlineAt: now + 600_000, outcome: "pending", composing: false });
};

describe("solicitation v1: unchanged", () => {
  it("solicitation-v1 a live pending solicitation is answered with the same body and records who answered", async () => {
    pend("sv1-a");
    const r = await resolve({ type: "solicitationResponse_write", solicitationId: "sv1-a", outcome: "answered", answer: "yes" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ resolved: true, shape: "solicitationResponse_write", body: { solicitationId: "sv1-a", outcome: "answered" } });
    const s = pendingSolicitations.get("sv1-a")!;
    expect([s.outcome, s.answer, s.answeredBy]).toEqual(["answered", "yes", "key:kid-plain"]);
  });

  it("solicitation-v1 a heartbeat extends a live pending solicitation with the same body", async () => {
    pend("sv1-h");
    const r = await resolve({ type: "solicitationHeartbeat_write", solicitationId: "sv1-h" });
    const j = (await r.json()) as { resolved: boolean; shape: string; body: Record<string, unknown> };
    expect([r.status, j.resolved, j.shape, Object.keys(j.body).sort()]).toEqual([200, true, "solicitationHeartbeat_write", ["deadlineAt", "maxDeadlineAt", "solicitationId"]]);
    expect(pendingSolicitations.get("sv1-h")!.composing).toBe(true);
  });

  it("solicitation-v1 an unknown or already answered id is the same 404", async () => {
    const r = await resolve({ type: "solicitationResponse_write", solicitationId: "sv1-none", outcome: "declined" });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ resolved: false, shape: "solicitationResponse_write", error: "no pending solicitation with that id" });
    pend("sv1-twice");
    await resolve({ type: "solicitationResponse_write", solicitationId: "sv1-twice", outcome: "answered", answer: "1" });
    expect((await resolve({ type: "solicitationResponse_write", solicitationId: "sv1-twice", outcome: "answered", answer: "2" })).status).toBe(404);
  });
});
