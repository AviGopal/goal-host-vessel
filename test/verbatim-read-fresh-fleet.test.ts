// A FRESH NODE'S "READ <abs path> AND TELL ME EXACTLY WHAT IT SAYS" MUST REACH WITHOUT AN LLM.
//
// Install acceptance (network run, podman spoke) dispatched "Read
// /workspace/validation/network-acceptance-marker.txt and tell me exactly what it says." three
// times. Target inference returned [] @0 — the LLM and concept recall a spoke resolves on the hub
// were unavailable — so the walk ran unrelated pool activities and went HOLLOW without ever
// reading the file. The goal is a member of the verbatim-read family (verbatimReadTarget), whose
// oracle already grades it deterministically; inference and path binding must be deterministic too.
//
// This runs the REAL goal-host (src/index.ts) against an in-process mock of a fresh fleet:
// discovery advertising local-tools' fileContent, no goal_paths, no templates, and an "LLM"
// endpoint that answers nothing parseable. The goal must reach, graded by the verbatim oracle,
// and the file must have been read at the path the goal names.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PATH = "/workspace/validation/network-acceptance-marker.txt";
const GOAL = `Read ${PATH} and tell me exactly what it says.`;
const MARKER = "network-acceptance-7f3a91c2-spoke\n";
const SHAPES = ["fileContent", "fs_read", "codeSearchResult", "source_code", "llm_completion", "memoryNote", "memoryNote_write", "substrateGap"];

let mock: ReturnType<typeof Bun.serve>;
let host: ReturnType<typeof Bun.spawn> | null = null;
let hostPort = 0;
let stateDir = "";
const fileReads: string[] = [];

beforeAll(async () => {
  mock = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      const body: any = req.method === "POST" ? await req.json().catch(() => null) : null;
      const me = `http://127.0.0.1:${mock.port}`;
      if (p === "/health") return Response.json({ ok: true });
      if (p === "/registry/shapes") return Response.json({ shapes: SHAPES });
      if (p === "/registry/stats") return Response.json({ totalVessels: 1, totalShapes: SHAPES.length, healthyCount: 1 });
      if (p === "/resolve") {
        const t = body?.pointer?.type;
        const row = { id: "local-tools-vessel", endpoint: me, resolve_endpoint: "/v2/impulses/resolve", shapes: SHAPES };
        if (t === "vesselRegistry") return Response.json({ content: { vessels: [row] } });
        if (t === "vesselCapability") return Response.json({ content: { vessels: SHAPES.includes(body?.pointer?.shape) ? [row] : [] } });
        return Response.json({ content: null });
      }
      if (p === "/v2/impulses/resolve") {
        const ptr = body?.impulse?.pointer ?? {};
        if (ptr.type === "fileContent") {
          const path = String(ptr.path ?? "");
          fileReads.push(path);
          if (path === PATH) return Response.json({ shape: "fileContent", path, content: MARKER });
          return Response.json({ error: `ENOENT: ${path}` }, { status: 404 });
        }
        return Response.json({ error: `mock: no resolver for ${ptr.type}` }, { status: 404 });
      }
      // A fresh store: no activities, no recommendations, no learned pathways.
      if (p === "/v2/activities" && req.method === "GET") return Response.json([]);
      if (p.endsWith("/recommend")) return Response.json({ recommendations: [] });
      if (req.method === "GET") return Response.json({}, { status: 404 });
      return Response.json({ ok: true });
    },
  });
  const E = `http://127.0.0.1:${mock.port}`;
  stateDir = mkdtempSync(join(tmpdir(), "gh-verbatim-fresh-"));
  hostPort = 20_000 + Math.floor(Math.random() * 20_000);
  host = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      PORT: String(hostPort), METABOB_API_KEY: "test-key", GOAL_HOST_VESSEL_API_KEY: "test-key",
      DISCOVERY_VESSEL_ENDPOINT: E, ACTIVITY_API_ENDPOINT: E, PRODUCER_DISCOVERY_ENDPOINT: E,
      DEVELOPMENT_VESSEL_ENDPOINT: E, EVENT_BUS_ENDPOINT: E, LLM_VESSEL_ENDPOINT: E,
      GOAL_HOST_DISABLE_SUBSCRIBERS: "1", GOAL_HOST_WS_SUBSCRIBER: "0", SUBSTRATE_STATE_DIR: stateDir,
      WORKSPACE_ROOT: stateDir,
      REACHED_CMD_CACHE_PATH: join(stateDir, "rc.json"), GOAL_FAILURE_MEMORY_PATH: join(stateDir, "fm.json"),
      REACH_VERDICT_SPOOL_PATH: join(stateDir, "spool"),
    },
    stdout: process.env.GH_TEST_LOG ? Bun.file(process.env.GH_TEST_LOG) : "ignore",
    stderr: process.env.GH_TEST_LOG ? Bun.file(process.env.GH_TEST_LOG) : "ignore",
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${hostPort}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* booting */ }
    await Bun.sleep(250);
  }
  throw new Error("goal-host did not come up");
}, 60_000);

afterAll(() => {
  host?.kill();
  mock?.stop(true);
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

describe("fresh node, no LLM, no concepts, fileContent advertised", () => {
  test("a verbatim read of a named absolute path reaches with the file's exact content", async () => {
    const r = await fetch(`http://127.0.0.1:${hostPort}/run-goal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "ApiKey test-key" },
      body: JSON.stringify({ goal: GOAL, tags: ["operator:test"] }),
    });
    const { dispatchId } = await r.json() as { dispatchId: string };
    expect(typeof dispatchId).toBe("string");
    let rec: any = null;
    for (let i = 0; i < 240; i++) {
      rec = await (await fetch(`http://127.0.0.1:${hostPort}/executions/${dispatchId}`)).json().catch(() => null);
      if (rec && rec.status && rec.status !== "running") break;
      await Bun.sleep(250);
    }
    const reason = String(rec?.goalReachReason ?? rec?.result?.goalReachReason ?? "");
    // The walk aimed at the file read and bound the goal's path into it.
    expect(fileReads).toContain(PATH);
    expect(fileReads.every((p) => p === PATH)).toBe(true);
    expect(rec?.reached).toBe(true);
    expect(reason).toContain("deterministic:");
    expect(JSON.stringify(rec)).toContain(MARKER.trim());
  }, 90_000);
});

// The routing decision itself, with and without an LLM: the deterministic layer decides a
// verbatim read, honours the knownShapes gate, and leaves everything outside the family alone.
import { inferGoalTargetDecision } from "../src/goal-target-inference";

describe("deterministic verbatim-read route", () => {
  const llmSays = (shapes: string[]) => ({
    complete: async () => JSON.stringify({ target_shapes: shapes }),
  });

  test("routes to fileContent with no LLM, and the LLM cannot override it", async () => {
    const noLLM = await inferGoalTargetDecision(GOAL, SHAPES, {});
    expect(noLLM.shapes).toEqual(["fileContent"]);
    expect(noLLM.alternatives).toEqual([]);
    const withLLM = await inferGoalTargetDecision(GOAL, SHAPES, llmSays(["memoryNote"]) as any);
    expect(withLLM.shapes).toEqual(["fileContent"]);
  });

  test("never routes to fs_read (weaker containment), even when it is the only reader advertised", async () => {
    const d = await inferGoalTargetDecision(GOAL, SHAPES.filter((s) => s !== "fileContent"), {});
    expect(d.shapes).not.toContain("fs_read");
  });

  test("declines when no file reader is advertised (no target a producer cannot serve)", async () => {
    const d = await inferGoalTargetDecision(GOAL, ["memoryNote", "llm_completion"], {});
    expect(d.shapes).not.toContain("fileContent");
    expect(d.shapes).not.toContain("fs_read");
  });

  test("abstains outside the family: a transformation, two paths, a repo-relative path, a read-then-persist", async () => {
    for (const g of [
      `Summarize ${PATH} in two sentences.`,
      `Read ${PATH} and /workspace/other.txt and tell me exactly what it says.`,
      "Read repos/goal-host-vessel/package.json and tell me exactly what it says.",
      `Read ${PATH} and tell me exactly what it says and save it as a memory note.`,
    ]) {
      const d = await inferGoalTargetDecision(g, SHAPES, {});
      expect(d.shapes).not.toContain("fileContent");
    }
  });
});
