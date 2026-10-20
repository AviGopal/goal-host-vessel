// IMPORTING index.ts HAS NO LIVE EFFECT (2026-10-19). A lane check that tests index.ts must import it, and the lane runs
// that check in a child whose env is only PATH, HOME, NODE_ENV and TZ: every endpoint and state path index.ts reads
// takes its live default. Module load used to ask discovery for the trace store, start the satisfier trace sink's spool
// replay, restore the dispatch store (posting oracle labels for reconciled records) and start its persist, requeue and
// resume timers, so a child that only imported the module reached the live fleet and the live /workspace. Those now run
// only in the service (import.meta.main); the satisfier sink is created on its first record.
// The child runs under a recorder that records and REFUSES every network call, spawn, listener and write, so even the
// parent tree has no live effect when this test runs it.
// MUST-FAIL at the parent: the import records network calls and writes outside the child's scratch HOME.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Effect { kind: "net" | "write" | "spawn" | "listen"; api: string; target: string }
interface EffectRecord { outcome: string; error?: string; effects: Effect[] }

const RECORDER = join(import.meta.dir, "fixtures", "effect-recorder.ts");
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const CONTROL = join(import.meta.dir, "fixtures", "one-fetch-one-write.ts");

/** Import `modulePath` in a child with the lane check child's env, by value (development-vessel's test child env:
 *  PATH and HOME passed through, NODE_ENV and TZ fixed; HOME is a fresh scratch dir here), under the recorder. */
async function importUnderRecorder(modulePath: string): Promise<{ home: string; rec: EffectRecord }> {
  const home = mkdtempSync(join(tmpdir(), "import-effects-"));
  try {
    const code = `const r = globalThis.__effectRecorder; try { await import(${JSON.stringify(modulePath)}); r.report("resolved"); } catch (e) { r.report("threw", e); } process.exit(0);`;
    const p = Bun.spawn([process.execPath, "--preload", RECORDER, "-e", code], {
      env: { PATH: process.env.PATH ?? "", HOME: home, NODE_ENV: "test", TZ: "UTC" },
      stdout: "ignore", stderr: "pipe",
    });
    const kill = setTimeout(() => p.kill(), 60_000);
    const stderr = await new Response(p.stderr).text();
    await p.exited;
    clearTimeout(kill);
    const line = stderr.split("\n").find((l) => l.startsWith("EFFECTS "));
    if (!line) throw new Error(`the child printed no effect record (rc ${p.exitCode}): ${stderr.slice(-800)}`);
    return { home, rec: JSON.parse(line.slice("EFFECTS ".length)) as EffectRecord };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const outsideScratch = (home: string, effects: Effect[]): Effect[] =>
  effects.filter((e) => !(e.kind === "write" && (e.target === home || e.target.startsWith(`${home}/`))));

describe("importing src/index.ts reaches nothing outside the importer", () => {
  test("[MUST-FAIL] the import makes no network call, spawn or listener and writes nothing outside the child's scratch HOME", async () => {
    const { home, rec } = await importUnderRecorder(INDEX);
    expect(outsideScratch(home, rec.effects)).toEqual([]);
  }, 90_000);

  test("[CONTROL] the same recorder and spawn record a fixture's one fetch and one fs write: exactly 2", async () => {
    const { rec } = await importUnderRecorder(CONTROL);
    expect(rec.outcome).toBe("resolved");
    expect(rec.effects.map((e) => `${e.kind}:${e.api}`)).toEqual(["net:fetch", "write:fs/promises.appendFile"]);
  }, 90_000);
});
