// CHILD for test/concept-recall-carries-execution-id.test.ts. Run as `bun <this file>` in a fresh process, never by
// `bun test` (the loader plugin applies only to a module not yet loaded; the technique of goal-path-record-child.ts).
//
// Exposes the module-private recallConceptRows and dispatchContext, points the concept-db url at one loopback stub
// (which answers every concept search with one row), and refuses any fetch elsewhere. One line out:
//   CONCEPT_RECALL_RESULT {"exposed":bool,"cases":[{label,searches:[pointer...]}],"refused":[url...]}
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_PATH = join(import.meta.dir, "..", "..", "src", "index.ts");
const escaped = INDEX_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
Bun.plugin({
  name: "concept-recall-export",
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escaped}$`) }, (args) => ({
      contents: `${readFileSync(args.path, "utf8")}\nexport { recallConceptRows as __t_recallConceptRows, dispatchContext as __t_dispatchContext };\nexport function __t_seedConceptDb(u: string): void { _conceptDbUrl = u; _conceptDbResolvedAt = Date.now(); }\n`,
      loader: "ts",
    }));
  },
});

const searches: Array<Record<string, unknown>> = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    const text = await req.text();
    if (req.method === "POST" && u.pathname === "/concept-db/resolve") {
      const ptr = (JSON.parse(text) as { impulse?: { pointer?: Record<string, unknown> } }).impulse?.pointer ?? {};
      if (ptr["type"] === "concept") searches.push(ptr);
      return Response.json({ content: [{ summary: "a recalled lesson", content: "the lesson body" }] });
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

type Recall = (query: string, limit: number, timeoutMs?: number, filters?: Record<string, unknown>) => Promise<unknown[] | null>;
const result: { exposed: boolean; cases: Array<{ label: string; rows: number[]; searches: Array<Record<string, unknown>> }>; refused: string[]; error?: string } = { exposed: false, cases: [], refused };
try {
  const mod = (await import(INDEX_PATH)) as Record<string, unknown>;
  const recall = mod["__t_recallConceptRows"] as Recall | undefined;
  const ctx = mod["__t_dispatchContext"] as { run<T>(s: { dispatchId: string }, f: () => T): T } | undefined;
  const seed = mod["__t_seedConceptDb"] as ((u: string) => void) | undefined;
  result.exposed = typeof recall === "function" && !!ctx && typeof seed === "function";
  if (recall && ctx && seed) {
    seed(`${ORIGIN}/concept-db/resolve`);
    const twice = async (label: string, q: string, dispatchId: string | null) => {
      const from = searches.length; const rows: number[] = [];
      for (let i = 0; i < 2; i++) {
        const r = dispatchId ? await ctx.run({ dispatchId }, () => recall(q, 3, 5_000)) : await recall(q, 3, 5_000);
        rows.push(Array.isArray(r) ? r.length : -1);
      }
      result.cases.push({ label, rows, searches: searches.slice(from) });
    };
    await twice("in-dispatch", "how to count files in a vessel", "dispatch-recall-1");
    await twice("no-context", "how to list a vessel's routes", null);
  }
} catch (e) {
  result.error = String((e as Error)?.stack ?? e).slice(0, 2000);
}
globalThis.fetch = realFetch;
server.stop(true);
console.log(`CONCEPT_RECALL_RESULT ${JSON.stringify(result)}`);
process.exit(0);
