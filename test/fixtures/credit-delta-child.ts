// CHILD for test/credit-delta-is-what-was-written.test.ts. Run as `bun <this file>` in a fresh process, never by
// `bun test` (the loader plugin applies only to a module not yet loaded; the technique of goal-path-record-child.ts).
//
// Exposes creditReachedTemplate and penaliseHollowTemplate and drives them against one loopback stub: POST
// /v2/activities/feedback answers 200, or 500 when the activity id says "rejected". Any fetch elsewhere is refused
// and recorded. One line out:
//   CREDIT_DELTA_RESULT {"exposed":bool,"cases":[{fn,activity,delta,posts}],"refused":[url...]}
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_PATH = join(import.meta.dir, "..", "..", "src", "index.ts");
const escaped = INDEX_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
Bun.plugin({
  name: "credit-delta-export",
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escaped}$`) }, (args) => ({
      contents: `${readFileSync(args.path, "utf8")}\nexport { creditReachedTemplate as __t_credit, penaliseHollowTemplate as __t_penalise };\n`,
      loader: "ts",
    }));
  },
});

let posts = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    const body = await req.text();
    if (req.method === "POST" && u.pathname === "/v2/activities/feedback") {
      posts++;
      return body.includes("rejected") ? Response.json({ error: "stub: no posterior row" }, { status: 404 }) : Response.json({ ok: true });
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

type Fn = (activityId: string, reason: string, goalText?: string) => Promise<{ templateId: string; dAlpha: number; dBeta: number }>;
const result: { exposed: boolean; cases: Array<{ fn: string; activity: string; delta: unknown; posts: number }>; refused: string[]; error?: string } = { exposed: false, cases: [], refused };
try {
  const mod = (await import(INDEX_PATH)) as Record<string, unknown>;
  const credit = mod["__t_credit"] as Fn | undefined;
  const penalise = mod["__t_penalise"] as Fn | undefined;
  result.exposed = typeof credit === "function" && typeof penalise === "function";
  if (credit && penalise) {
    for (const [name, fn] of [["credit", credit], ["penalise", penalise]] as const) {
      for (const activity of ["satisfier:credit-delta-written", "satisfier:credit-delta-rejected"]) {
        const from = posts;
        const delta = await fn(activity, "credit delta fixture");
        result.cases.push({ fn: name, activity, delta, posts: posts - from });
      }
    }
  }
} catch (e) {
  result.error = String((e as Error)?.stack ?? e).slice(0, 2000);
}
globalThis.fetch = realFetch;
server.stop(true);
console.log(`CREDIT_DELTA_RESULT ${JSON.stringify(result)}`);
process.exit(0);
