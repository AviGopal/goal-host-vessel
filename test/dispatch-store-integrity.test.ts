// THE DISPATCH STORE SURVIVES A RESTART: WRITTEN WHOLE, AWAITED AT SHUTDOWN, AND A BAD FILE IS KEPT, NEVER OVERWRITTEN.
//
// Gap: the-goal-host-dispatch-store-is-written-non-atomically-and-not-awaited-at-shutdown-so-a-restart-can-truncate-it-
// and-the-next-boot-silently-starts-empty. Measured: a node's store of 138 records restored nothing after a restart and
// the host's 5 s persist then wrote its empty store over the file.
//
//   [MUST-FAIL] a truncated or corrupt store at boot is moved aside to <path>.corrupt-<ISO> with its bytes intact and
//               logged loudly; the host starts empty and never overwrites it (module and a spawned host)
//   [MUST-FAIL] a write is atomic: a reader polling during a large write sees the old whole file or the new whole file,
//               never a part, and no temp file is left
//   [MUST-FAIL] shutdown awaits one final persist before exiting, and a host stopped right after boot leaves a parseable
//               store holding every record
//   [CONTROL]   first boot with no file starts empty with no corrupt log and moves nothing
//   [CONTROL]   a normal restart restores every record
//
// Every host here runs on its own state dir (hostStateEnv), never /workspace. Fixture words from a 5-word draw
// (draw-words.sh): 2026-10-30T02:02:29Z seed=1793325749068109129 words=matchbox aftermost clump curvature denial
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStateEnv } from "./fixtures/host-state-env";

const D = (await import("../src/dispatch-store-file").catch(() => ({}))) as Record<string, any>;
const ROOT = join(import.meta.dir, "..");
const SRC = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const rec = (i: number, extra = "") => ({ dispatchId: `matchbox-aftermost-${i}`, startedAt: 1_700_000_000_000 + i, status: "completed", goal: `count the curvature of the aftermost matchbox clump ${i}${extra}` });
const TRUNCATED = JSON.stringify([rec(1), rec(2), rec(3)]).slice(0, 77);

async function runHost(stateDir: string, until: RegExp | null, ms: number, signalAfter?: RegExp) {
  const p = Bun.spawn(["bun", join(ROOT, "src", "index.ts")], {
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...hostStateEnv(stateDir),
      PORT: String(20_000 + Math.floor(Math.random() * 20_000)), METABOB_API_KEY: "test-key", GOAL_HOST_VESSEL_API_KEY: "test-key",
      DISCOVERY_VESSEL_ENDPOINT: "http://127.0.0.1:9", ACTIVITY_API_ENDPOINT: "http://127.0.0.1:9", PRODUCER_DISCOVERY_ENDPOINT: "http://127.0.0.1:9",
      DEVELOPMENT_VESSEL_ENDPOINT: "http://127.0.0.1:9", EVENT_BUS_ENDPOINT: "http://127.0.0.1:9", LLM_VESSEL_ENDPOINT: "http://127.0.0.1:9",
      GOAL_HOST_DISABLE_SUBSCRIBERS: "1", GOAL_HOST_WS_SUBSCRIBER: "0",
    },
    stdout: "pipe", stderr: "pipe",
  });
  let out = "";
  const dec = new TextDecoder();
  const pump = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) out += dec.decode(c); };
  void pump(p.stdout as ReadableStream<Uint8Array>); void pump(p.stderr as ReadableStream<Uint8Array>);
  let code: number | null = null;
  void p.exited.then((c) => { code = c; });
  const t0 = Date.now();
  let signalled = false;
  while (Date.now() - t0 < ms && code === null) {
    if (signalAfter && !signalled && signalAfter.test(out)) { p.kill("SIGTERM"); signalled = true; }
    if (until && until.test(out)) break;
    await Bun.sleep(100);
  }
  if (code === null) p.kill("SIGKILL");
  await p.exited;
  return { out, signalled };
}
const storeOf = (d: string) => join(d, "goal-host-dispatches.json");
const asideOf = (d: string) => readdirSync(d).filter((f) => f.startsWith("goal-host-dispatches.json.corrupt-"));

describe("the store file module", () => {
  test("[MUST-FAIL] a truncated store at boot is moved aside, bytes intact, not overwritten", async () => {
    const d = tmp("ds-trunc-");
    writeFileSync(storeOf(d), TRUNCATED);
    const r = await D["readStoreAtBoot"]?.(storeOf(d), new Date("2026-10-30T02:20:00.000Z"));
    expect(r?.status).toBe("corrupt");
    expect(r?.movedTo).toBe(`${storeOf(d)}.corrupt-2026-10-30T02-20-00-000Z`);
    expect(readFileSync(r!.movedTo, "utf8")).toBe(TRUNCATED);
    expect(existsSync(storeOf(d))).toBe(false);
    // valid JSON that is not a store is corrupt too
    writeFileSync(storeOf(d), JSON.stringify({ not: "an array" }));
    expect((await D["readStoreAtBoot"]?.(storeOf(d)))?.status).toBe("corrupt");
  });

  test("[MUST-FAIL] a write is atomic: a reader sees a whole file throughout, and no temp file is left", async () => {
    const d = tmp("ds-atomic-");
    const old = JSON.stringify([rec(0)]);
    writeFileSync(storeOf(d), old);
    const big = JSON.stringify(Array.from({ length: 20_000 }, (_, i) => rec(i, " curvature ".repeat(20))));
    expect(big.length).toBeGreaterThan(5_000_000);
    let done = false; let reads = 0; let partial = 0;
    const w = (D["writeStoreAtomic"]?.(storeOf(d), big) ?? Promise.reject(new Error("absent"))).finally(() => { done = true; });
    while (!done) {
      const t = readFileSync(storeOf(d), "utf8"); reads++;
      if (t !== old && t !== big) partial++;
      await Bun.sleep(0);
    }
    await w;
    expect(reads).toBeGreaterThan(0);
    expect(partial).toBe(0);
    expect(readFileSync(storeOf(d), "utf8")).toBe(big);
    expect(readdirSync(d).filter((f) => f.includes(".tmp-"))).toEqual([]);
  }, 30_000);

  test("[CONTROL] a missing store is a first boot: status missing, nothing created or moved", async () => {
    const d = tmp("ds-missing-");
    expect(await D["readStoreAtBoot"]?.(storeOf(d))).toEqual({ status: "missing", records: [] });
    expect(readdirSync(d)).toEqual([]);
  });
});

describe("the spawned host (its own state dir)", () => {
  test("[MUST-FAIL] a host booting on a truncated store logs it, moves it aside intact, and never overwrites it", async () => {
    const d = tmp("ds-host-trunc-");
    writeFileSync(storeOf(d), TRUNCATED);
    // wait past one 5 s persist tick after boot, so an overwrite would have happened
    const { out } = await runHost(d, null, 9_000);
    expect(out).toContain("DISPATCH STORE UNREADABLE at boot");
    const aside = asideOf(d);
    expect(aside.length).toBe(1);
    expect(readFileSync(join(d, aside[0]!), "utf8")).toBe(TRUNCATED);
  }, 30_000);

  test("[MUST-FAIL] shutdown awaits one final persist before exiting; a host stopped right after boot leaves every record, parseable", async () => {
    const at = SRC.indexOf("async function gracefulShutdown(");
    const end = SRC.indexOf("process.exit(0);", at);
    expect(SRC.slice(at, end)).toContain("await Promise.race([storeWritesSettled().then(() => persistDispatchStoreAwaited()),");
    const d = tmp("ds-host-stop-");
    const many = Array.from({ length: 3_000 }, (_, i) => rec(i, " clump ".repeat(30)));
    writeFileSync(storeOf(d), JSON.stringify(many));
    const { out, signalled } = await runHost(d, /\[goal-host-vessel\] stopped/, 30_000, /dispatch store: restored \d+ records/);
    expect(signalled).toBe(true);
    expect(out).toContain("[goal-host-vessel] stopped");
    const after = JSON.parse(readFileSync(storeOf(d), "utf8")) as Array<{ dispatchId: string }>;
    expect(after.length).toBe(3_000);
    expect(readdirSync(d).filter((f) => f.includes(".tmp-"))).toEqual([]);
  }, 40_000);

  test("[CONTROL] first boot with no file starts empty, with no corrupt log and nothing moved", async () => {
    const d = tmp("ds-host-first-");
    const { out } = await runHost(d, /started on port/, 30_000);
    expect(out).not.toContain("DISPATCH STORE UNREADABLE");
    expect(asideOf(d)).toEqual([]);
  }, 40_000);

  test("[CONTROL] a normal restart restores every record", async () => {
    const d = tmp("ds-host-ok-");
    writeFileSync(storeOf(d), JSON.stringify([rec(1), rec(2), rec(3)]));
    const { out } = await runHost(d, /dispatch store: restored \d+ records/, 30_000);
    expect(out).toMatch(/dispatch store: restored 3 records from disk/);
    expect(out).not.toContain("DISPATCH STORE UNREADABLE");
  }, 40_000);
});
