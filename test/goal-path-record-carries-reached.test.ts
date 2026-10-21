// THE GOAL-PATH RECORD CARRIES THE REACH VERDICT AS `reached`, BESIDE `success`.
//
// recordGoalPath posts every walk's path to activity-api POST /v2/goal-paths. It sent the walk's reach verdict only as
// `success`. The receiver is moving to grade a path (its counters and α/β) only when the body carries an explicit
// `reached` boolean: an absent `reached` is ungraded and writes nothing. A receiver that lands before this sender would
// black out goal-path learning, so the sender sends the verdict under both names first. The current receiver's schema
// is non-strict and drops a key it does not know, so sending it early changes nothing there.
//
//   [MUST-FAIL] the body recordGoalPath posts carries `reached` as a boolean equal to the walk's verdict (true, false).
//   [CONTROL]   the same body still carries `success` equal to the verdict, on both sides.
//
// recordGoalPath is module-private, so a Bun loader plugin appends one export line to src/index.ts as it loads (the
// verdict-diff harness's technique; the file on disk is not modified). Every endpoint the call touches (discovery,
// development-vessel, activity-api) points at one loopback stub, and any fetch to anywhere else throws, so no live
// service is reached.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_PATH = join(import.meta.dir, "..", "src", "index.ts");
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

const realFetch = globalThis.fetch;
const refused: string[] = [];
type RecordGoalPath = (goalText: string, pathActivities: string[], reached: boolean, durationMs: number, costUsd: number) => Promise<void>;
let recordGoalPath: RecordGoalPath;

beforeAll(async () => {
  for (const k of ["ACTIVITY_API_ENDPOINT", "DEVELOPMENT_VESSEL_ENDPOINT", "DISCOVERY_VESSEL_ENDPOINT", "LLM_VESSEL_ENDPOINT"]) process.env[k] = ORIGIN;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${ORIGIN}/`)) { refused.push(url); return Promise.reject(new TypeError("fetch refused (test: stub only)")); }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  const mod = (await import("../src/index")) as Record<string, unknown>;
  recordGoalPath = mod["__t_recordGoalPath"] as RecordGoalPath;
}, 60_000);

afterAll(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
});

/** Drive recordGoalPath once and return the parsed body of the one POST /v2/goal-paths it made. */
async function postedFor(goal: string, reached: boolean): Promise<Record<string, unknown>> {
  const from = captured.length;
  await recordGoalPath(goal, ["goal-path-record-test-step"], reached, 1_234, 0);
  const posts = captured.slice(from).filter((c) => c.method === "POST" && c.path === "/v2/goal-paths");
  expect(posts.length).toBe(1);
  const body = JSON.parse(posts[0]!.body) as Record<string, unknown>;
  expect(body["goal_text"]).toBe(goal);
  return body;
}

const GOAL_REACHED = "Summarise the reach verdict sender test fixture, reached side";
const GOAL_HOLLOW = "Summarise the reach verdict sender test fixture, hollow side";

describe("the goal-path record carries the walk's reach verdict as `reached`", () => {
  test("the module exposes recordGoalPath through the loader plugin", () => {
    expect(typeof recordGoalPath).toBe("function");
  });

  test("[MUST-FAIL] a reached walk posts reached: true", async () => {
    const body = await postedFor(GOAL_REACHED, true);
    expect(typeof body["reached"]).toBe("boolean");
    expect(body["reached"]).toBe(true);
  });

  test("[MUST-FAIL] a walk that did not reach posts reached: false", async () => {
    const body = await postedFor(GOAL_HOLLOW, false);
    expect(typeof body["reached"]).toBe("boolean");
    expect(body["reached"]).toBe(false);
  });

  test("[CONTROL] success is unchanged: it still equals the verdict, on both sides", async () => {
    const yes = await postedFor(`${GOAL_REACHED} (control)`, true);
    const no = await postedFor(`${GOAL_HOLLOW} (control)`, false);
    expect(yes["success"]).toBe(true);
    expect(no["success"]).toBe(false);
  });

  test("[CONTROL] no request left the loopback stub", () => {
    expect(refused).toEqual([]);
  });
});
