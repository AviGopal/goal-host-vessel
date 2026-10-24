// CHILD for test/goal-path-recorded-from-the-write.test.ts. Run as `bun <this file>` in a fresh process, never by
// `bun test` (the loader plugin applies only to a module not yet loaded; the same technique as goal-path-record-child.ts).
//
// Exposes the module-private recordGoalPath and drives it against one loopback stub that answers POST /v2/goal-paths
// with 200, or with 500 when the goal text says "rejected". Any fetch elsewhere is refused and recorded. One line out:
//   GOAL_PATH_RESULT_RESULT {"exposed":bool,"cases":[{goal,status,resolved,posts}],"refused":[url...]}
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_PATH = join(import.meta.dir, "..", "..", "src", "index.ts");
const escaped = INDEX_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
Bun.plugin({
  name: "goal-path-record-result-export",
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escaped}$`) }, (args) => ({
      contents: `${readFileSync(args.path, "utf8")}\nexport { recordGoalPath as __t_recordGoalPath };\n`,
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
    if (req.method === "POST" && u.pathname === "/v2/goal-paths") {
      posts++;
      return body.includes("rejected") ? Response.json({ error: "stub: refused" }, { status: 500 }) : Response.json({ success: true });
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

type RecordGoalPath = (goalText: string, pathActivities: string[], reached: boolean, durationMs: number, costUsd: number) => Promise<unknown>;
const result: { exposed: boolean; cases: Array<{ goal: string; resolved: unknown; posts: number }>; refused: string[]; error?: string } = { exposed: false, cases: [], refused };
try {
  const mod = (await import(INDEX_PATH)) as Record<string, unknown>;
  const recordGoalPath = mod["__t_recordGoalPath"] as RecordGoalPath | undefined;
  result.exposed = typeof recordGoalPath === "function";
  if (recordGoalPath) {
    for (const goal of ["Count the files of the goal-path result fixture, written", "Count the files of the goal-path result fixture, rejected"]) {
      const from = posts;
      const resolved = await recordGoalPath(goal, ["goal-path-result-test-step"], true, 1_000, 0);
      result.cases.push({ goal, resolved: resolved === undefined ? "undefined" : resolved, posts: posts - from });
    }
    // no path: nothing is written
    result.cases.push({ goal: "(empty path)", resolved: await recordGoalPath("Count the files, empty path", [], true, 0, 0) ?? "undefined", posts: 0 });
  }
} catch (e) {
  result.error = String((e as Error)?.stack ?? e).slice(0, 2000);
}
globalThis.fetch = realFetch;
server.stop(true);
console.log(`GOAL_PATH_RESULT_RESULT ${JSON.stringify(result)}`);
process.exit(0);
