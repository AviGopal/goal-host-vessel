// A TEST'S SPAWNED GOAL-HOST NEVER RUNS ON /workspace STATE.
//
// Three tests Bun.spawn src/index.ts as a host with a replaced env and left GOAL_HOST_DISPATCH_STORE_PATH out, so inside a
// substrate container their host restored and persisted the LIVE /workspace/goal-host-dispatches.json. Now every
// spawning test passes hostStateEnv(stateDir) (test/fixtures/host-state-env.ts: every /workspace-defaulting store path
// into its own state dir). The guard reads only existing env reads: a host whose state dir (SUBSTRATE_STATE_DIR) is off
// /workspace while another store path still resolves under it refuses to boot, and a host whose state dir is off
// /workspace skips the boot reconcile that reads the hard-coded /workspace/proposals. No new env switch (law 1).
//
//   [MUST-FAIL] (a) the store keys re-derived from src/ (every `process.env.X ?? "/workspace..."`) equal the guard's list,
//               and hostStateEnv redirects every one of them under the test's state dir
//   [MUST-FAIL] (b) a state dir off /workspace with a /workspace store path (a sentinel): the host exits non-zero before
//               touching any store; the sentinel and the state dir's store are never created
//   [CONTROL]   production defaults (every path unset, all under /workspace) never trip; nor does a host that keeps its
//               state dir under /workspace whatever its other paths say
//   [CONTROL]   a state dir off /workspace with every path redirected boots, restores its own store and skips the
//               edit-intent reconcile (one line)
//   [CONTROL]   every test that spawns the host passes hostStateEnv
//
// Run on the HOST only (the host processes here never see a container's /workspace).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStateEnv } from "./fixtures/host-state-env";

const G = (await import("../src/test-host-guard").catch(() => ({}))) as Record<string, any>;
const ROOT = join(import.meta.dir, "..");
const SRC = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (/\.ts$/.test(e) && !/\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}
/** The same derivation as the gate's scrubbed_env: every env read with a /workspace default in the host's source. */
function derivedKeys(): string[] {
  const re = /process\.env(?:\.([A-Z0-9_]+)|\[["']([A-Z0-9_]+)["']\])\s*(?:\?\?|\|\|)\s*["'`]\/workspace/g;
  const keys = new Set<string>();
  for (const f of srcFiles(join(ROOT, "src"))) for (const m of readFileSync(f, "utf8").matchAll(re)) keys.add(m[1] ?? m[2]!);
  return [...keys].sort();
}

async function runHost(env: Record<string, string>, waitFor: RegExp | null, ms: number) {
  const p = Bun.spawn(["bun", join(ROOT, "src", "index.ts")], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  let out = "";
  const dec = new TextDecoder();
  const pump = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) out += dec.decode(c); };
  void pump(p.stdout as ReadableStream<Uint8Array>); void pump(p.stderr as ReadableStream<Uint8Array>);
  const t0 = Date.now();
  let code: number | null = null;
  void p.exited.then((c) => { code = c; });
  while (Date.now() - t0 < ms && code === null && !(waitFor && waitFor.test(out))) await Bun.sleep(100);
  if (code === null) p.kill();
  await p.exited;
  return { code, out };
}

const deadEnv = (stateDir: string) => ({
  PORT: String(20_000 + Math.floor(Math.random() * 20_000)), METABOB_API_KEY: "test-key", GOAL_HOST_VESSEL_API_KEY: "test-key",
  DISCOVERY_VESSEL_ENDPOINT: "http://127.0.0.1:9", ACTIVITY_API_ENDPOINT: "http://127.0.0.1:9", PRODUCER_DISCOVERY_ENDPOINT: "http://127.0.0.1:9",
  DEVELOPMENT_VESSEL_ENDPOINT: "http://127.0.0.1:9", EVENT_BUS_ENDPOINT: "http://127.0.0.1:9", LLM_VESSEL_ENDPOINT: "http://127.0.0.1:9",
  GOAL_HOST_DISABLE_SUBSCRIBERS: "1", GOAL_HOST_WS_SUBSCRIBER: "0", ...hostStateEnv(stateDir),
});

describe("the store keys and the redirect", () => {
  test("[MUST-FAIL] (a) the keys re-derived from src/ equal the guard's list; hostStateEnv redirects each, with the marker", () => {
    expect([...(G["WORKSPACE_DEFAULTED_STATE_KEYS"] ?? [])].sort()).toEqual(derivedKeys());
    const d = "/tmp/state-x";
    const env = hostStateEnv(d) as Record<string, string>;
    for (const k of derivedKeys()) {
      expect(env[k]).toBeDefined();
      expect(env[k]!.startsWith(d)).toBe(true);
    }
    expect(env["GOAL_HOST_TEST_HOST"]).toBeUndefined(); // no new env switch
    expect(G["testHostRefusal"]?.(env)).toBeNull();
  });

  test("[CONTROL] production defaults never trip (the live unit sets none of these); the guard runs first in the boot", () => {
    expect(typeof G["testHostRefusal"]).toBe("function");
    // the live unit's env: every store path unset, so every one at its /workspace default
    expect(G["testHostRefusal"]({})).toBeNull();
    expect(G["stateDirOffWorkspace"]({})).toBe(false);
    // a state dir kept under /workspace never trips, whatever the other paths say
    expect(G["testHostRefusal"]({ SUBSTRATE_STATE_DIR: "/workspace/state", GOAL_HOST_DISPATCH_STORE_PATH: "/tmp/x.json" })).toBeNull();
    expect(G["testHostRefusal"]({ GOAL_HOST_DISPATCH_STORE_PATH: "/workspace/goal-host-dispatches.json" })).toBeNull();
    // the gate's scrubbed_env: the state dir AND every store path under its throwaway root -> boots
    const se: Record<string, string> = {};
    for (const k of G["WORKSPACE_DEFAULTED_STATE_KEYS"]) se[k] = `/tmp/se-root/ws/${k}`;
    expect(G["testHostRefusal"](se)).toBeNull();
    // half-redirected: the state dir off /workspace, the dispatch store left at its default -> refused
    expect(G["testHostRefusal"]({ ...se, GOAL_HOST_DISPATCH_STORE_PATH: undefined })).toContain("GOAL_HOST_DISPATCH_STORE_PATH");
    const main = SRC.indexOf("if (import.meta.main) {");
    const guard = SRC.indexOf("const _refusal = testHostRefusal();", main);
    const restore = SRC.indexOf("await restoreDispatchStoreAtBoot();", main);
    expect(main).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(main);
    expect(restore).toBeGreaterThan(guard);
    expect(SRC.slice(main, guard)).not.toMatch(/\bawait\b|satisfierTraceSink|persistDispatchStore/);
  });

  test("[CONTROL] every test that spawns the host passes hostStateEnv", () => {
    const spawners = readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.ts") && f !== "host-spawn-state-env.test.ts")
      .filter((f) => /Bun\.spawn\(\["bun", join\(import\.meta\.dir, "\.\.", "src", "index\.ts"\)\]/.test(readFileSync(join(ROOT, "test", f), "utf8")));
    expect(spawners.sort()).toEqual(["deterministic-transient-retry.test.ts", "required-inputs-are-bound-before-a-producer-is-invoked.test.ts", "verbatim-read-fresh-fleet.test.ts"]);
    for (const f of spawners) expect(readFileSync(join(ROOT, "test", f), "utf8")).toContain("...hostStateEnv(stateDir),");
  });
});

describe("the spawned host under the marker", () => {
  test("[MUST-FAIL] (b) a state dir off /workspace with a /workspace store path (sentinel): the host exits non-zero before touching any store", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gh-guard-")); dirs.push(stateDir);
    const sentinel = `/workspace/__goal-host-guard-sentinel-${process.pid}-${Date.now()}/goal-host-dispatches.json`;
    const { code, out } = await runHost({ ...deadEnv(stateDir), GOAL_HOST_DISPATCH_STORE_PATH: sentinel }, null, 30_000);
    expect(code).toBe(78);
    expect(out).toContain("REFUSING TO BOOT: the state dir (SUBSTRATE_STATE_DIR=");
    expect(out).toContain("GOAL_HOST_DISPATCH_STORE_PATH");
    expect(out).not.toContain("dispatch store: restored");
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(sentinel.slice(0, sentinel.lastIndexOf("/")))).toBe(false); // nothing written under the sentinel default
    expect(existsSync(join(stateDir, "goal-host-dispatches.json"))).toBe(false);
    expect(readdirSync(stateDir)).toEqual([]); // and no store at all: it exited before touching any
  }, 40_000);

  test("[CONTROL] a state dir off /workspace with every path redirected: the host boots on its own store and skips the edit-intent reconcile", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gh-guard-ok-")); dirs.push(stateDir);
    const store = join(stateDir, "goal-host-dispatches.json");
    writeFileSync(store, JSON.stringify([{ dispatchId: "seed-edit", startedAt: Date.now() - 1_000, status: "running", goal: "edit repos/goal-host-vessel/src/none.ts to add a line" }]));
    const { out } = await runHost(deadEnv(stateDir), /dispatch store: restored \d+ records/, 30_000);
    expect(out).toContain("boot reconcile of edit-intent dispatches SKIPPED: the state dir is off /workspace");
    expect(out).toMatch(/dispatch store: restored 1 records from disk/);
    expect(out).not.toContain("REFUSING TO BOOT");
  }, 40_000);

  test("[MUST-FAIL] the stores derived from the dispatch store's directory (verdict consistency, request queue) land under the state dir", () => {
    // index.ts sets both roots to dirname(DISPATCH_STORE_PATH); under hostStateEnv that is the state dir
    expect(SRC).toContain("verdictConsistency.setVerdictConsistencyRoot(dirname(DISPATCH_STORE_PATH));");
    expect(SRC).toContain("requestQueue.setRequestQueueRoot(dirname(DISPATCH_STORE_PATH));");
    const d = "/tmp/state-y";
    const env = hostStateEnv(d) as Record<string, string>;
    expect(env["GOAL_HOST_DISPATCH_STORE_PATH"]!.slice(0, env["GOAL_HOST_DISPATCH_STORE_PATH"]!.lastIndexOf("/"))).toBe(d);
  });
});
