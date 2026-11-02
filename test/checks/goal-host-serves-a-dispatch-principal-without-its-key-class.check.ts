import { describe, expect, test } from "bun:test";
import * as mod from "../../src/index";

// Asserts on the activeDispatches arm of the resolve handler (src/index.ts ~20542:
// `if (type === "activeDispatches") { const statusFilter = body.status ?? pointer.status; ...`).
// Today the served principal is {kind, operator, tag} and never carries the key's class.

type Rec = Record<string, unknown>;
const m = mod as unknown as Rec;

function store(): unknown {
  const f = m["__dispatchStoreForTests"];
  return typeof f === "function" ? (f as () => unknown)() : undefined;
}

function seed(id: string, rec: Rec): void {
  const s = store();
  if (s instanceof Map) { s.set(id, rec); return; }
  if (s && typeof s === "object") {
    const o = s as Rec;
    const setter = o["set"];
    if (typeof setter === "function") (setter as (k: string, v: unknown) => void).call(o, id, rec);
    else o[id] = rec;
  }
}

function unseed(id: string): void {
  const s = store();
  if (s instanceof Map) { s.delete(id); return; }
  if (s && typeof s === "object") {
    const o = s as Rec;
    const del = o["delete"];
    if (typeof del === "function") (del as (k: string) => void).call(o, id);
    else delete o[id];
  }
}

async function serveActive(): Promise<unknown> {
  const h = m["handleResolve"];
  if (typeof h !== "function") return undefined;
  const fn = h as (...a: unknown[]) => unknown;
  const payload = { impulse: { pointer: { type: "activeDispatches" }, body: {} }, pointer: { type: "activeDispatches" }, body: {} };
  const attempts: unknown[][] = [
    [new Request("http://localhost/v2/impulses/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })],
    [payload],
    [{ type: "activeDispatches" }, {}],
  ];
  for (const args of attempts) {
    try {
      let r: unknown = await fn(...args);
      if (r instanceof Response) r = await r.json();
      if (r !== undefined && r !== null) return r;
    } catch { /* try the next calling form */ }
  }
  return undefined;
}

function findById(x: unknown, id: string, depth = 0): Rec | null {
  if (depth > 8 || x === null || typeof x !== "object") return null;
  if (Array.isArray(x)) {
    for (const v of x) { const f = findById(v, id, depth + 1); if (f) return f; }
    return null;
  }
  const o = x as Rec;
  if (o["id"] === id || o["dispatch_id"] === id || o["dispatchId"] === id) return o;
  for (const v of Object.values(o)) { const f = findById(v, id, depth + 1); if (f) return f; }
  return null;
}

function record(id: string, principal: Rec, keyId: string | null): Rec {
  return {
    id,
    dispatch_id: id,
    dispatchId: id,
    status: "running",
    goal: "check goal",
    started_at: new Date().toISOString(),
    startedAt: Date.now(),
    ...(keyId ? { key_id: keyId, keyId } : {}),
    principal,
  };
}

describe("activeDispatches serves the principal's key class", () => {
  test("a system-class key dispatch reads class system on the served activeDispatches; no key id served", async () => {
    const id = "chk-sys-key-dispatch-1";
    const keyId = "chk-sys-key-id-77";
    seed(id, record(id, { kind: "key", operator: "system", key_id: keyId, keyId, class: "system", key_class: "system", label: "reach-system" }, keyId));
    try {
      const served = await serveActive();
      const row = findById(served, id);
      const principal = (row?.["principal"] ?? null) as Rec | null;
      expect(principal?.["class"]).toBe("system");
      expect(JSON.stringify(served ?? null).includes(keyId)).toBe(false);
    } finally {
      unseed(id);
    }
  });

  test("control: a node_self principal serves as today with no key id in the body", async () => {
    const id = "chk-node-self-dispatch-1";
    seed(id, record(id, { kind: "node_self", operator: "node_self" }, null));
    try {
      const served = await serveActive();
      const row = findById(served, id);
      const principal = (row?.["principal"] ?? null) as Rec | null;
      if (principal) expect(principal["kind"]).toBe("node_self");
      expect(JSON.stringify(served ?? null).includes("chk-sys-key-id-77")).toBe(false);
    } finally {
      unseed(id);
    }
  });
});
