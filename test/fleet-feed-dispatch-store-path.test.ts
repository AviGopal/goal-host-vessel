// THE DISPATCH STORE A PROCESS LOADS IS THE ONE ITS ENVIRONMENT NAMES (2026-10-17). index.ts read a LITERAL
// /workspace/goal-host-dispatches.json at module load, so every test child that imports it (fleet-feed-provenance's
// probe among them) hydrated the LIVE dispatches, served their goal and answer URLs in fleetActivityFeed (red when run
// alone in the container, green on a host with no such file and inside a whole-suite run), and the requeue drain
// rewrote the live file 15 s after load. The path is now GOAL_HOST_DISPATCH_STORE_PATH with the same default.
// MUST-FAIL at the parent ec718b8: the child ignores the scratch store and the seeded dispatch is absent.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function probeWith(store: string): Promise<string> {
  const p = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "fleet-feed-provenance-probe.ts")], {
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT: "0",
      GOAL_HOST_VESSEL_API_KEY: "mb-test-fleet-feed-store-path-0123456789", FED_SUBSTRATE_ID: "this-substrate",
      FED_TRANSPORT_EGRESS: "http://127.0.0.1:18401",
      DISCOVERY_VESSEL_ENDPOINT: "http://127.0.0.1:18100", PRODUCER_DISCOVERY_ENDPOINT: "http://127.0.0.1:18080",
      ACTIVITY_API_ENDPOINT: "http://127.0.0.1:18080", LLM_VESSEL_ENDPOINT: "http://127.0.0.1:18220",
      DEVELOPMENT_VESSEL_ENDPOINT: "http://127.0.0.1:18090",
      GOAL_HOST_DISABLE_SUBSCRIBERS: "1", GOAL_HOST_WS_SUBSCRIBER: "0", GOAL_HOST_DISPATCH_STORE_PATH: store,
    },
    stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.split("\n").find((l) => l.startsWith("PROBE ")) ?? "";
}

describe("the dispatch store follows GOAL_HOST_DISPATCH_STORE_PATH", () => {
  test("[MUST-FAIL] a dispatch seeded in the named scratch store is the one the feed serves (the live store is never read)", async () => {
    const store = join(mkdtempSync(join(tmpdir(), "fleet-feed-seeded-")), "goal-host-dispatches.json");
    writeFileSync(store, JSON.stringify([{ dispatchId: "d-seeded-store-1", goal: "seeded goal", status: "completed", reached: true, startedAt: 1, endedAt: 2 }]));
    const line = await probeWith(store);
    expect(line).not.toBe("");
    expect(line).toContain("d-seeded-store-1");
  }, 60_000);

  test("[CONTROL] an absent named store serves no local dispatches", async () => {
    const store = join(mkdtempSync(join(tmpdir(), "fleet-feed-absent-")), "goal-host-dispatches.json");
    const line = await probeWith(store);
    expect(line).not.toBe("");
    expect(line).not.toContain("d-seeded-store-1");
  }, 60_000);

  test("[WIRING] index.ts reads the store path from GOAL_HOST_DISPATCH_STORE_PATH with the live default unchanged", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(src).toContain('const DISPATCH_STORE_PATH = process.env["GOAL_HOST_DISPATCH_STORE_PATH"] ?? "/workspace/goal-host-dispatches.json";');
  });
});
