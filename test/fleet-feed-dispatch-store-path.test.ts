// THE DISPATCH STORE A PROCESS LOADS IS THE ONE ITS ENVIRONMENT NAMES (2026-10-17). index.ts read a LITERAL
// /workspace/goal-host-dispatches.json at module load, so every test child that imports it (fleet-feed-provenance's
// probe among them) hydrated the LIVE dispatches, served their goal and answer URLs in fleetActivityFeed (red when run
// alone in the container, green on a host with no such file and inside a whole-suite run), and the requeue drain
// rewrote the live file 15 s after load. The path is now GOAL_HOST_DISPATCH_STORE_PATH with the same default.
// ONLY THE SERVICE RESTORES IT (2026-10-19). The restore, its requeue and resume timers and the persist interval now
// run under import.meta.main, so an importer loads no store at all, named or live, and never rewrites one. The other
// half, that the service still restores the named store and serves it, is the boot smoke (it binds a port, so it is
// not a suite test). The importer runs under the effect recorder, which records and refuses every write and network
// call, so the probe has no live effect whatever it reaches.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function probeWith(store: string): Promise<{ line: string; storeEffects: string[] }> {
  const p = Bun.spawn(["bun", "--preload", join(import.meta.dir, "fixtures", "effect-recorder.ts"), join(import.meta.dir, "fixtures", "fleet-feed-provenance-probe.ts")], {
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT: "0",
      GOAL_HOST_VESSEL_API_KEY: "mb-test-fleet-feed-store-path-0123456789", FED_SUBSTRATE_ID: "this-substrate",
      FED_TRANSPORT_EGRESS: "http://127.0.0.1:18401",
      DISCOVERY_VESSEL_ENDPOINT: "http://127.0.0.1:18100", PRODUCER_DISCOVERY_ENDPOINT: "http://127.0.0.1:18080",
      ACTIVITY_API_ENDPOINT: "http://127.0.0.1:18080", LLM_VESSEL_ENDPOINT: "http://127.0.0.1:18220",
      DEVELOPMENT_VESSEL_ENDPOINT: "http://127.0.0.1:18090",
      GOAL_HOST_DISABLE_SUBSCRIBERS: "1", GOAL_HOST_WS_SUBSCRIBER: "0", GOAL_HOST_DISPATCH_STORE_PATH: store,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const rec = err.split("\n").find((l) => l.startsWith("EFFECTS "));
  const effects = rec ? (JSON.parse(rec.slice("EFFECTS ".length)) as { effects: Array<{ api: string; target: string }> }).effects : [];
  return {
    line: out.split("\n").find((l) => l.startsWith("PROBE ")) ?? "",
    storeEffects: effects.filter((e) => e.target === store).map((e) => `${e.api} ${e.target}`),
  };
}

describe("the dispatch store follows GOAL_HOST_DISPATCH_STORE_PATH and only the service loads it", () => {
  test("[MUST-FAIL] an importer does not restore: a dispatch seeded in the named store is absent from the feed it serves, and the store is never written", async () => {
    const store = join(mkdtempSync(join(tmpdir(), "fleet-feed-seeded-")), "goal-host-dispatches.json");
    writeFileSync(store, JSON.stringify([{ dispatchId: "d-seeded-store-1", goal: "seeded goal", status: "completed", reached: true, startedAt: 1, endedAt: 2 }]));
    const { line, storeEffects } = await probeWith(store);
    expect(line).not.toBe("");
    expect(line).not.toContain("d-seeded-store-1");
    expect(storeEffects).toEqual([]);
  }, 60_000);

  test("[CONTROL] an absent named store serves no local dispatches", async () => {
    const store = join(mkdtempSync(join(tmpdir(), "fleet-feed-absent-")), "goal-host-dispatches.json");
    const { line } = await probeWith(store);
    expect(line).not.toBe("");
    expect(line).not.toContain("d-seeded-store-1");
  }, 60_000);

  test("[WIRING] index.ts reads the store path from GOAL_HOST_DISPATCH_STORE_PATH with the live default unchanged, and restores and persists it only under import.meta.main", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(src).toContain('const DISPATCH_STORE_PATH = process.env["GOAL_HOST_DISPATCH_STORE_PATH"] ?? "/workspace/goal-host-dispatches.json";');
    const main = src.indexOf("if (import.meta.main) {");
    expect(main).toBeGreaterThan(-1);
    expect(src.indexOf("JSON.parse(await Bun.file(DISPATCH_STORE_PATH).text())")).toBeGreaterThan(main);
    expect(src.indexOf("setInterval(persistDispatchStore, 5000);")).toBeGreaterThan(main);
  });
});
