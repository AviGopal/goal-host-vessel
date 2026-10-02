// A FRESH NODE'S KNOWN-ANSWER GOAL MUST SURVIVE ONE TRANSIENT 5xx.
//
// The install acceptance check (`usable`) dispatches "How many vessels are currently registered
// in the discovery registry? Report the number." On a fresh node there is no learned pathway, so
// the walk aims at shellResult and runs the code-authored registry-count command through the
// shell resolver. That command was given exactly one try: a single 503 from a vessel that was
// still coming up sent it to the self-correction loop, the walk ended at 0 steps, the floor (which
// no longer offers a shell, floor-tools.ts) could not route around it, and the dispatch failed —
// the failure signature the acceptance run reported. Before 5b10279 the floor's own shellResult
// call was the de-facto retry.
//
// This runs the REAL goal-host (src/index.ts) against an in-process mock of a fresh fleet:
// discovery advertising local-tools' shellResult, no goal_paths, no templates, and a shell
// resolver whose FIRST call answers 503. The goal must still reach, by the deterministic oracle.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GOAL = "How many vessels are currently registered in the discovery registry? Report the number.";
const SHAPES = ["shellResult", "shell", "bounded_shell", "codeSearchResult", "fs_read", "source_code", "llm_completion", "memoryNote", "memoryNote_write", "substrateGap"];
const TOTAL_VESSELS = 8;

let mock: ReturnType<typeof Bun.serve>;
let host: ReturnType<typeof Bun.spawn> | null = null;
let hostPort = 0;
let stateDir = "";
let shellCalls = 0;
const shellCommands: string[] = [];

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
      if (p === "/registry/stats") return Response.json({ totalVessels: TOTAL_VESSELS, totalShapes: SHAPES.length, healthyCount: TOTAL_VESSELS });
      if (p === "/resolve") {
        const t = body?.pointer?.type;
        const row = { id: "local-tools-vessel", endpoint: me, resolve_endpoint: "/v2/impulses/resolve", shapes: SHAPES };
        if (t === "vesselRegistry") return Response.json({ content: { vessels: [row] } });
        if (t === "vesselCapability") return Response.json({ content: { vessels: SHAPES.includes(body?.pointer?.shape) ? [row] : [] } });
        return Response.json({ content: null });
      }
      if (p === "/v2/impulses/resolve") {
        const ptr = body?.impulse?.pointer ?? {};
        if (ptr.type === "shellResult") {
          shellCalls++;
          const cmd = String(ptr.command ?? "");
          shellCommands.push(cmd);
          // The vessel is still coming up: its FIRST answer is a 503.
          if (shellCalls === 1) return new Response("upstream unavailable", { status: 503 });
          if (/registry\/stats/.test(cmd) && /totalVessels/.test(cmd)) return Response.json({ shape: "shellResult", stdout: `${TOTAL_VESSELS}\n`, stderr: "", exit_code: 0 });
          return Response.json({ shape: "shellResult", stdout: "", stderr: "mock: unrecognised command", exit_code: 1 });
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
  stateDir = mkdtempSync(join(tmpdir(), "gh-transient-"));
  hostPort = 20_000 + Math.floor(Math.random() * 20_000);
  host = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      PORT: String(hostPort), METABOB_API_KEY: "test-key", GOAL_HOST_VESSEL_API_KEY: "test-key",
      DISCOVERY_VESSEL_ENDPOINT: E, ACTIVITY_API_ENDPOINT: E, PRODUCER_DISCOVERY_ENDPOINT: E,
      DEVELOPMENT_VESSEL_ENDPOINT: E, EVENT_BUS_ENDPOINT: E, LLM_VESSEL_ENDPOINT: E,
      GOAL_HOST_DISABLE_SUBSCRIBERS: "1", GOAL_HOST_WS_SUBSCRIBER: "0", SUBSTRATE_STATE_DIR: stateDir,
      REACHED_CMD_CACHE_PATH: join(stateDir, "rc.json"), GOAL_FAILURE_MEMORY_PATH: join(stateDir, "fm.json"),
      REACH_VERDICT_SPOOL_PATH: join(stateDir, "spool"),
    },
    stdout: "ignore",
    stderr: "ignore",
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

describe("fresh node, no learned pathway, first shell resolve answers 503", () => {
  test("the known-answer registry goal still reaches through the deterministic registry-count oracle", async () => {
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
    expect(reason).not.toContain("no template produces the inferred target shapes");
    expect(rec?.reached).toBe(true);
    expect(reason).toContain("deterministic:verified-registry-count");
    // The 503 was absorbed by re-running the SAME code-authored command, not a rewritten one.
    expect(shellCalls).toBeGreaterThanOrEqual(2);
    expect(shellCommands[1]).toBe(shellCommands[0]);
  }, 90_000);
});
