// AN IMPORTER LOADS index.ts WITH NO LLM CONFIGURED (2026-10-19). index.ts created its LLM port at module load, and
// createLLMPort throws when neither LLM_VESSEL_ENDPOINT nor an Anthropic client is configured. The lane runs a check in
// a child whose env is only PATH, HOME, NODE_ENV and TZ, so every check that must import index.ts died at load
// (load_error), before any assertion could run. The port is now made on first use; with nothing configured the same
// createLLMPort error surfaces at execute time instead.
// Each child runs under the effect recorder (fixtures/effect-recorder.ts), which records and refuses every network call,
// spawn, listener and write, so the import has no live effect whatever it reaches.
// MUST-FAIL at the parent: the import throws the createLLMPort error.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RECORDER = join(import.meta.dir, "fixtures", "effect-recorder.ts");
const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const EXIT_BUDGET_MS = 20_000;

/** `bun -e 'await import(index.ts); process.exit(0)'` with the lane check child's env, by value (development-vessel's
 *  test child env: PATH and HOME passed through, NODE_ENV and TZ fixed; HOME is a fresh scratch dir), plus `extra`. */
async function importIndex(extra: Record<string, string> = {}): Promise<{ rc: number | null; killed: boolean; ms: number; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "llm-port-lazy-"));
  try {
    const t0 = Date.now();
    const p = Bun.spawn([process.execPath, "--preload", RECORDER, "-e", `await import(${JSON.stringify(INDEX)}); process.exit(0);`], {
      env: { PATH: process.env.PATH ?? "", HOME: home, NODE_ENV: "test", TZ: "UTC", ...extra },
      stdout: "ignore", stderr: "pipe",
    });
    let killed = false;
    const kill = setTimeout(() => { killed = true; p.kill(); }, EXIT_BUDGET_MS);
    const stderr = await new Response(p.stderr).text();
    await p.exited;
    clearTimeout(kill);
    return { rc: p.exitCode, killed, ms: Date.now() - t0, stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("index.ts loads in the lane's check env", () => {
  test("[MUST-FAIL] with no LLM endpoint configured the import completes: rc 0 and no createLLMPort error", async () => {
    const r = await importIndex();
    expect(r.stderr).not.toContain("createLLMPort");
    expect(r.rc).toBe(0);
  }, 60_000);

  test("[CONTROL] the same import with LLM_VESSEL_ENDPOINT set (a discard address) completes: rc 0 and no createLLMPort error", async () => {
    const r = await importIndex({ LLM_VESSEL_ENDPOINT: "http://127.0.0.1:9" });
    expect(r.stderr).not.toContain("createLLMPort");
    expect(r.rc).toBe(0);
  }, 60_000);

  test("[EXIT-TIME] the import completes and the process exits within 20 s, unkilled", async () => {
    const r = await importIndex();
    expect(r.killed).toBe(false);
    expect(r.ms).toBeLessThan(EXIT_BUDGET_MS);
    expect(r.rc).toBe(0);
  }, 60_000);
});
