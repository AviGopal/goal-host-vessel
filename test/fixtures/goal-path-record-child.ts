// CHILD for test/goal-path-record-carries-reached.test.ts. Run as `bun <this file>` in a fresh process, never by `bun test`.
//
// recordGoalPath is module-private. A Bun loader plugin appends one export line to src/index.ts as it loads (the
// verdict-diff child's technique; the file on disk is not modified). The plugin only applies to a module not yet loaded,
// so this must run in its own process: in a one-process suite another file has usually imported index.ts first.
//
// Every endpoint the call touches (discovery, development-vessel, activity-api) points at one loopback stub, and any
// fetch to anywhere else is refused and recorded, so no live service is reached. The result is one line on stdout:
//   GOAL_PATH_RECORD_RESULT {"exposed":bool,"cases":[{goal,reached,posts,body}],"refused":[url...]}
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_PATH = join(import.meta.dir, "..", "..", "src", "index.ts");
const escaped = INDEX_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
Bun.plugin({
  name: "goal-path-record-export",
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escaped}$`) }, (args) => ({
      contents: `${readFileSync(args.path, "utf8")}\nexport { recordGoalPath as __t_recordGoalPath };\n`,
      loader: "ts",
    }));
  },
});

interface Captured { method: string; path: string; body: string }
const captured: Captured[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    captured.push({ method: req.method, path: u.pathname, body: await req.text() });
    if (req.method === "POST" && u.pathname === "/v2/goal-paths") return Response.json({ success: true });
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

type RecordGoalPath = (goalText: string, pathActivities: string[], reached: boolean, durationMs: number, costUsd: number) => Promise<void>;
const result: { exposed: boolean; cases: Array<{ goal: string; reached: boolean; posts: number; body: Record<string, unknown> | null }>; refused: string[]; error?: string } = { exposed: false, cases: [], refused };
try {
  const mod = (await import(INDEX_PATH)) as Record<string, unknown>;
  const recordGoalPath = mod["__t_recordGoalPath"] as RecordGoalPath | undefined;
  result.exposed = typeof recordGoalPath === "function";
  if (recordGoalPath) {
    const CASES: Array<[string, boolean]> = [
      ["Summarise the reach verdict sender test fixture, reached side", true],
      ["Summarise the reach verdict sender test fixture, hollow side", false],
      ["Summarise the reach verdict sender test fixture, reached side (control)", true],
      ["Summarise the reach verdict sender test fixture, hollow side (control)", false],
    ];
    for (const [goal, reached] of CASES) {
      const from = captured.length;
      await recordGoalPath(goal, ["goal-path-record-test-step"], reached, 1_234, 0);
      const posts = captured.slice(from).filter((c) => c.method === "POST" && c.path === "/v2/goal-paths");
      result.cases.push({ goal, reached, posts: posts.length, body: posts[0] ? (JSON.parse(posts[0].body) as Record<string, unknown>) : null });
    }
  }
} catch (e) {
  result.error = String((e as Error)?.stack ?? e).slice(0, 2000);
}
globalThis.fetch = realFetch;
server.stop(true);
console.log(`GOAL_PATH_RECORD_RESULT ${JSON.stringify(result)}`);
process.exit(0);
