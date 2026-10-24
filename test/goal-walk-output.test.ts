// ONE WALK OUTPUT'S FULL CONTENT, READ BY ITS POOL ID, AFTER THE WALK (row a-finished-runs-output-content-is-not-
// readable-by-id-after-the-walk-ends, its second need: the human surface's "show as page").
//
// goalWalkState's poolProvenance[] serves a 2000-char preview of each output (contentPreview, chars, truncated), and
// the live pool is forgotten when the walk ends, so nothing could read an output past the cut. The walk's state mirror
// now keeps each output's content (bounded) on the dispatch record beside the preview, from the same string, and the
// goalWalkOutput shape serves it through goal-host's own /resolve handler.
//
//   [MUST-FAIL] a dispatch whose output is > 2000 chars: goalWalkState still serves the 2000-char preview with
//               truncated:true, and goalWalkOutput {dispatchId, impulseId} serves the FULL content (length == chars),
//               with contentType, producedBy and producerExecutionId.
//   [MUST-FAIL] the mirror keeps the output from the preview's own string; pruneStore clears it with the preview;
//               the shape is advertised beside goalWalkState.
//   [CONTROL]   an unknown impulseId and an unknown (or expired) dispatch are a shaped not-found (resolved:false, 404),
//               like goalWalkState's; goalWalkState's own body is unchanged (exact keys, preview as before); an
//               unauthenticated read is refused; the caps are declared and reported.
//
// Identity is a globalThis.fetch stub (the harness test/request-queue-resolve.test.ts uses).
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDENTITY = "http://127.0.0.1:59171";
const NODE_KEY = "gwo-test-node-key";
const PLAIN_KEY = "gwo-test-plain-key";

process.env.LLM_VESSEL_ENDPOINT ??= "http://127.0.0.1:65535";
// Importing index.ts starts its 5 s memory-dump writer: point it at scratch, never the live dump.
process.env["MEM_DUMP_PATH"] = join(mkdtempSync(join(tmpdir(), "goal-walk-output-memdump-")), "mem-dump.json");
process.env["GOAL_HOST_DISPATCH_STORE_PATH"] = join(mkdtempSync(join(tmpdir(), "goal-walk-output-store-")), "goal-host-dispatches.json");
const gh = await import("../src/index");
const ia = await import("../src/inbound-auth");
const wp = await import("../src/walk-pool");
const { __resetCredentialCacheForTests } = await import("../src/caller-credential");
const { handleResolve, markInboundRemote, __inboundAuthStateForTests } = gh;
const { executionStore } = __inboundAuthStateForTests;

const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const realFetch = globalThis.fetch;
const spies: Array<ReturnType<typeof spyOn>> = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["IDENTITY_VESSEL_URL", "METABOB_API_KEY"]) saved[k] = process.env[k];
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  process.env["METABOB_API_KEY"] = NODE_KEY;
  __resetCredentialCacheForTests();
  ia.__resetInboundAuthForTests();
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      const key = String((JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: { apiKey?: string } } })?.impulse?.pointer?.apiKey ?? "");
      if (key !== PLAIN_KEY) return Response.json({ success: false, error: "invalid" }, { status: 401 });
      return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "kid-plain", scopes: ["read", "write"] } });
    }
    return Response.json({ error: "no network in this test" }, { status: 503 });
  }) as unknown as typeof fetch;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) spies.push(spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  while (spies.length) spies.pop()!.mockRestore();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
afterAll(() => { executionStore.clear(); });

function resolve(payload: Record<string, unknown>, authorization: string | null = `ApiKey ${PLAIN_KEY}`): Promise<Response> {
  const req = new Request("http://goal-host.test/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "goal-walk-output-probe/1", ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(payload),
  });
  return handleResolve(markInboundRemote(req, "127.0.0.1"));
}
async function json(r: Response): Promise<{ status: number; j: Record<string, any> }> { return { status: r.status, j: (await r.json()) as Record<string, any> }; }

// A finished walk's record as mirrorWalkState leaves it: the preview row exactly as the mirror builds it, and the kept
// output from the keeper the mirror calls, on the same serialized string.
const D = "gwo-dispatch-1";
const OUT_ID = "walk-boot01-abc1234-web_page-7";
const PAGE = "<html>" + "x".repeat(4_990) + "</html>"; // > 2000 chars, a string output
const JSON_ID = "walk-boot01-abc1234-webSearchResult-8";
const JSON_OUT = { results: Array.from({ length: 60 }, (_, i) => ({ title: `t${i}`, url: `https://example.test/${i}`, snippet: "s".repeat(40) })) };
// The kept output is written as the keeper returns it under both caps (the caps test pins the keeper itself), so the
// fixture also builds at the parent commit, where the read is what is absent.
function finishedRecord(): void {
  const poolOutputs: Record<string, unknown> = {};
  const row = (id: string, shape: string, producedBy: string, exec: string, content: unknown) => {
    const c = typeof content === "string" ? content : JSON.stringify(content);
    poolOutputs[id] = { text: c, chars: c.length, truncated: false, contentType: typeof content === "string" ? "text" : "json" };
    return { id, shape, goalSignature: null, producedBy, producerExecutionId: exec, consumedIds: [], contentPreview: c.slice(0, 2000), chars: c.length, truncated: c.length > 2000 };
  };
  executionStore.set(D, {
    dispatchId: D, startedAt: Date.now(), endedAt: Date.now(), status: "completed", reached: true, goal: "show the page", executionId: "exec_gwo1", selectedTemplateId: "walk",
    poolShapes: ["web_page", "webSearchResult"],
    poolProvenance: [
      row(OUT_ID, "web_page", "satisfier:web_page", "exec_page1", PAGE),
      row(JSON_ID, "webSearchResult", "activity:learned-satisfier-web-search-result", "exec_search1", JSON_OUT),
      { id: "walk-boot01-abc1234-goal-1", shape: "goal", goalSignature: null, producedBy: "seed", producerExecutionId: null, consumedIds: [], chars: 0 },
    ],
    poolOutputs,
  } as never);
}

describe("goalWalkOutput: one output in full, after the walk", () => {
  it("[MUST-FAIL] an output > 2000 chars: goalWalkState serves the cut preview, goalWalkOutput serves all of it (length == chars)", async () => {
    finishedRecord();
    const ws = await json(await resolve({ type: "goalWalkState", dispatchId: D }, null));
    expect(ws.status).toBe(200);
    const prev = (ws.j.body.poolProvenance as Array<Record<string, any>>).find((p) => p.id === OUT_ID)!;
    expect(prev.contentPreview.length).toBe(2000);
    expect(prev.truncated).toBe(true);
    expect(prev.chars).toBe(PAGE.length);

    const r = await json(await resolve({ type: "goalWalkOutput", dispatchId: D, impulseId: OUT_ID }));
    expect(r.status).toBe(200);
    expect(r.j.resolved).toBe(true);
    expect(r.j.shape).toBe("goalWalkOutput");
    expect(r.j.body.content).toBe(PAGE);
    expect(r.j.body.content.length).toBe(prev.chars);
    expect(r.j.body).toMatchObject({ dispatchId: D, impulseId: OUT_ID, shape: "web_page", contentType: "text", producedBy: "satisfier:web_page", producerExecutionId: "exec_page1", chars: PAGE.length, truncated: false });
  });

  it("[MUST-FAIL] a JSON output is served as its serialized text, the string its preview was cut from; the impulse-wrapper form works", async () => {
    finishedRecord();
    const r = await json(await resolve({ impulse: { pointer: { type: "goalWalkOutput", dispatchId: D, impulseId: JSON_ID } } }));
    expect(r.status).toBe(200);
    expect(r.j.body.contentType).toBe("json");
    expect(JSON.parse(r.j.body.content)).toEqual(JSON_OUT);
    expect(r.j.body.chars).toBe(JSON.stringify(JSON_OUT).length);
    expect(r.j.body.producedBy).toBe("activity:learned-satisfier-web-search-result");
  });

  it("[MUST-FAIL] the walk's state mirror keeps each output from the preview's own string; pruneStore clears it with the preview; the shape is advertised", () => {
    const mirror = SRC.slice(SRC.indexOf("const mirrorWalkState = (): void => {"), SRC.indexOf("rec.pendingTargets = [...target]"));
    expect(mirror).toContain("const keepOutput = walkOutputKeeper();");
    expect(mirror).toContain('if (hasContent) poolOutputs[im.id] = keepOutput(c, typeof im.content === "string");');
    expect(mirror).toContain("(rec as { poolOutputs?: unknown }).poolOutputs = poolOutputs;");
    const prune = SRC.slice(SRC.indexOf("function pruneStore(): void {"), SRC.indexOf("function pruneStore(): void {") + 700);
    expect(prune).toMatch(/d\["poolProvenance"\] = \[\];\s*\n\s*d\["poolOutputs"\] = \{\};/);
    expect(SRC).toMatch(/const SHAPES = \[[^\]]*"goalWalkState", "goalWalkOutput",/);
  });

  it("[CONTROL] an unknown impulseId is a shaped not-found, not a throw", async () => {
    finishedRecord();
    const r = await json(await resolve({ type: "goalWalkOutput", dispatchId: D, impulseId: "walk-nope-0" }));
    expect(r.status).toBe(404);
    expect(r.j).toMatchObject({ resolved: false, shape: "goalWalkOutput", error: "output not found", body: { dispatchId: D, impulseId: "walk-nope-0" } });
  });

  it("[CONTROL] an unknown or expired dispatch is a not-found like goalWalkState's; a compacted record serves no output", async () => {
    const ws = await json(await resolve({ type: "goalWalkState", dispatchId: "gwo-gone" }, null));
    const r = await json(await resolve({ type: "goalWalkOutput", dispatchId: "gwo-gone", impulseId: OUT_ID }));
    expect(r.status).toBe(ws.status);
    expect(r.status).toBe(404);
    expect(r.j).toEqual({ resolved: false, shape: "goalWalkOutput", error: ws.j.error });
    finishedRecord();
    const rec = executionStore.get(D) as unknown as Record<string, unknown>;
    rec["poolProvenance"] = []; rec["poolOutputs"] = {}; rec["compacted"] = true; // what pruneStore does
    expect((await json(await resolve({ type: "goalWalkOutput", dispatchId: D, impulseId: OUT_ID }))).status).toBe(404);
    expect((await json(await resolve({ type: "goalWalkOutput", dispatchId: D }))).status).toBe(400);
  });

  it("[CONTROL] goalWalkState's body is unchanged: the same keys, the same preview, no full content", async () => {
    finishedRecord();
    const ws = await json(await resolve({ type: "goalWalkState", dispatchId: D }, null));
    expect(Object.keys(ws.j.body)).toEqual(["dispatchId", "status", "reached", "poolShapes", "poolProvenance", "pendingTargets", "poolEvents", "routeArounds", "walkLog", "currentStep", "steps", "walkTier", "executionPath", "attemptCount", "grounded", "learning", "answerBody", "goal", "operator", "operator_label", "principal", "executionId", "selectedTemplateId", "goalReachReason", "completionShapes", "humanGraded", "humanReachNotes", "trigger", "requeueOf", "resolverAnswers"]);
    expect(JSON.stringify(ws.j.body)).not.toContain(PAGE);
    expect(Object.keys(ws.j.body.poolProvenance[0])).toEqual(["id", "shape", "goalSignature", "producedBy", "producerExecutionId", "consumedIds", "contentPreview", "chars", "truncated"]);
    expect(ws.j.body.poolProvenance[0].contentPreview).toBe(PAGE.slice(0, 2000));
  });

  it("[MUST-FAIL] a record mirrored before outputs were kept serves its preview, marked truncated, never a not-found", async () => {
    finishedRecord();
    const rec = executionStore.get(D) as unknown as Record<string, unknown>;
    delete rec["poolOutputs"];
    const r = await json(await resolve({ type: "goalWalkOutput", dispatchId: D, impulseId: OUT_ID }));
    expect(r.status).toBe(200);
    expect(r.j.body).toMatchObject({ impulseId: OUT_ID, shape: "web_page", contentType: null, content: PAGE.slice(0, 2000), chars: PAGE.length, truncated: true });
    const g = await json(await resolve({ type: "goalWalkOutput", dispatchId: D, impulseId: "walk-boot01-abc1234-goal-1" }));
    expect(g.j.body).toMatchObject({ content: "", chars: 0, truncated: false });
  });

  it("[CONTROL] the full read is gated: no key or a rejected key is refused and serves nothing", async () => {
    finishedRecord();
    for (const auth of [null, "ApiKey not-a-key"]) {
      const r = await resolve({ type: "goalWalkOutput", dispatchId: D, impulseId: OUT_ID }, auth);
      expect(r.status).toBe(401);
      expect(await r.text()).not.toContain("xxxxxxxxxx");
    }
  });

  it("[CONTROL] the caps are declared and reported: chars is the full length, truncated marks a kept prefix", () => {
    expect(wp.WALK_OUTPUT_CAP_CHARS).toBe(1_000_000);
    expect(wp.WALK_OUTPUTS_RECORD_CAP_CHARS).toBe(2_000_000);
    const keep = wp.walkOutputKeeper();
    const big = "a".repeat(wp.WALK_OUTPUT_CAP_CHARS + 10);
    const a = keep(big, true);
    expect(a).toEqual({ text: big.slice(0, wp.WALK_OUTPUT_CAP_CHARS), chars: big.length, truncated: true, contentType: "text" });
    const b = keep(big, true); // the record has 1,000,000 left
    expect(b.text.length).toBe(wp.WALK_OUTPUTS_RECORD_CAP_CHARS - wp.WALK_OUTPUT_CAP_CHARS);
    const c = keep("later output", false); // over the record cap: nothing kept, still reported
    expect(c).toEqual({ text: "", chars: 12, truncated: true, contentType: "json" });
    expect(wp.walkOutputKeeper()("small", true)).toEqual({ text: "small", chars: 5, truncated: false, contentType: "text" });
  });
});
