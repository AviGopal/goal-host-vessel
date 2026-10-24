// CHILD for test/reach-verdict-recalled-concepts.test.ts. Run as `bun <this file>` in a fresh process, never by
// `bun test` (the loader plugin applies only to a module not yet loaded; the technique of concept-recall-child.ts).
//
// Exposes the module-private recallConceptRows and dispatchContext, points concept-db and activity-api at one loopback
// stub (concept searches answer with the ids named per query; POST /reach is recorded and answers updated:1), and
// refuses any fetch elsewhere. Each case runs dispatches the way /run-goal does (enter the context, begin the recall
// record at the root), recalls, and delivers the REAL reach verdict. One line out:
//   REACH_RECALLED_RESULT {"exposed":bool,"reach":{<execution id>: body},"refused":[url...]}
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_PATH = join(import.meta.dir, "..", "..", "src", "index.ts");
const escaped = INDEX_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
Bun.plugin({
  name: "reach-recalled-export",
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escaped}$`) }, (args) => ({
      contents: `${readFileSync(args.path, "utf8")}\nexport { recallConceptRows as __t_recallConceptRows, dispatchContext as __t_dispatchContext };\nexport function __t_seedConceptDb(u: string): void { _conceptDbUrl = u; _conceptDbResolvedAt = Date.now(); }\n`,
      loader: "ts",
    }));
  },
});

const IDS_BY_QUERY: Record<string, string[]> = {
  "q-a": ["concept:concept_a1", "concept:concept_shared"],
  "q-b": ["concept:concept_shared", "concept:concept_b1"],
  "q-c": ["concept:concept_c1"],
  "q-many": Array.from({ length: 60 }, (_, i) => `concept:concept_m${i}`),
};
const reach: Record<string, Record<string, unknown>> = {};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    const text = await req.text();
    if (req.method === "POST" && u.pathname === "/concept-db/resolve") {
      const ptr = (JSON.parse(text) as { impulse?: { pointer?: Record<string, unknown> } }).impulse?.pointer ?? {};
      const ids = IDS_BY_QUERY[String(ptr["query"])] ?? [];
      return Response.json({ content: ids.map((id) => ({ id, summary: `lesson ${id}`, content: "the lesson body" })) });
    }
    if (req.method === "POST" && u.pathname === "/v2/activities/execution-traces/reach") {
      const b = JSON.parse(text) as Record<string, unknown>;
      reach[String(b["execution_id"])] = b;
      return Response.json({ success: true, execution_id: b["execution_id"], reached: b["reached"], updated: 1 });
    }
    return Response.json({ error: "stub: not served" }, { status: 404 });
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;
for (const k of ["ACTIVITY_API_ENDPOINT", "DEVELOPMENT_VESSEL_ENDPOINT", "DISCOVERY_VESSEL_ENDPOINT", "LLM_VESSEL_ENDPOINT"]) process.env[k] = ORIGIN;

const realFetch = globalThis.fetch;
const refused: string[] = [];
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(`${ORIGIN}/`)) { refused.push(url); return Promise.reject(new TypeError("fetch refused (test: stub only)")); }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

type Store = { dispatchId: string; [k: string]: unknown };
type Ctx = { run<T>(s: Store, f: () => T): T; getStore(): Store | undefined };
type Recall = (query: string, limit: number, timeoutMs?: number) => Promise<unknown[] | null>;
type Deliver = (executionId: string, reached: unknown, completionShapes: string[] | null, origin: string, reason?: string | null, goalHash?: string | null, betaWithheld?: ReadonlyMap<string, string> | null) => void;
const result: { exposed: boolean; rootBegins: boolean; reach: typeof reach; refused: string[]; error?: string } = { exposed: false, rootBegins: false, reach, refused };
try {
  const mod = (await import(INDEX_PATH)) as Record<string, unknown>;
  const dc = (await import(join(import.meta.dir, "..", "..", "src", "dispatch-context.ts"))) as Record<string, unknown>;
  const recall = mod["__t_recallConceptRows"] as Recall | undefined;
  const ctx = mod["__t_dispatchContext"] as Ctx | undefined;
  const seed = mod["__t_seedConceptDb"] as ((u: string) => void) | undefined;
  const deliver = mod["deliverReachVerdict"] as Deliver | undefined;
  const enter = dc["enterDispatchContext"] as (prev: Store | undefined, own: Store) => Store;
  // The root entry's recall-record start; a build without one runs the dispatch with none (nothing is noted).
  const begin = (dc["beginRecallRecord"] as ((s: Store | undefined) => void) | undefined) ?? (() => {});
  result.rootBegins = typeof dc["beginRecallRecord"] === "function";
  result.exposed = typeof recall === "function" && !!ctx && typeof seed === "function" && typeof deliver === "function" && typeof enter === "function";
  if (recall && ctx && seed && deliver) {
    seed(`${ORIGIN}/concept-db/resolve`);
    // A dispatch as /run-goal runs it: enter over the current store, then begin the root's recall record.
    const dispatch = <T>(dispatchId: string, f: () => Promise<T>): Promise<T> => ctx.run(enter(ctx.getStore(), { dispatchId }), async () => { begin(ctx.getStore()); return f(); });
    const deliverHere = (execId: string, reached = true) => deliver(execId, reached, ["shellResult"], "test", null, null, null);

    // recalled: two recalls (one id shared), then the cost re-entry under a DIFFERENT id (variables.dispatch_id) delivers.
    await dispatch("d-rec", async () => {
      await recall("q-a", 3, 5_000);
      await recall("q-b", 3, 5_000);
      await ctx.run(enter(ctx.getStore(), { dispatchId: "var-dispatch-id" }), async () => deliverHere("trace-recalled"));
    });
    // nested: an in-process dispatch started inside another keeps its own record, and the outer keeps its own.
    await dispatch("d-outer", async () => {
      await recall("q-a", 3, 5_000);
      await dispatch("d-inner", async () => { await recall("q-c", 3, 5_000); deliverHere("trace-inner", false); });
      deliverHere("trace-outer");
    });
    // none: a dispatch that recalled nothing.
    await dispatch("d-none", async () => { deliverHere("trace-none"); });
    // cap: one recall returning 60 ids.
    await dispatch("d-many", async () => { await recall("q-many", 60, 5_000); deliverHere("trace-many"); });
    // no root: a store no root entry began notes nothing.
    await ctx.run({ dispatchId: "d-noroot" }, async () => { await recall("q-a", 3, 5_000); deliverHere("trace-noroot"); });
    // outside any dispatch.
    deliverHere("trace-nocontext");

    const want = ["trace-recalled", "trace-inner", "trace-outer", "trace-none", "trace-many", "trace-noroot", "trace-nocontext"];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !want.every((k) => k in reach)) await new Promise((r) => setTimeout(r, 50));
  }
} catch (e) {
  result.error = String((e as Error)?.stack ?? e).slice(0, 2000);
}
globalThis.fetch = realFetch;
server.stop(true);
console.log(`REACH_RECALLED_RESULT ${JSON.stringify(result)}`);
process.exit(0);
