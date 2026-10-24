// THE DISPATCH-STORE RESTORE IS A CALLABLE BOOT STEP (restoreDispatchStoreAtBoot), CALLED ONLY BY THE SERVICE.
//
// Since import-safety C1'/C2' the restore (boot reconciliation, oracle label, interrupted requeue, resume) ran inline in
// `if (import.meta.main)`, so the hermetic verdict-diff child, which imports index.ts, could never replay a restart: its
// three boot-* scenarios seed /workspace/goal-host-dispatches.json and nothing read it. The block is now one function.
// The service calls it exactly where the inline block ran; the verdict-diff child calls it in its boot phase. An
// importer that does not call it still restores nothing.
//
// test/fixtures/boot-restore-child.ts imports index.ts in a CHILD process with a seeded store (GOAL_HOST_DISPATCH_STORE_PATH)
// and no network, in two modes: "boot" calls the restore, "import" does not.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
const CHILD = join(import.meta.dir, "fixtures", "boot-restore-child.ts");
const MARK = "BOOT_RESTORE_RESULT ";
const SEED = JSON.stringify([
  { dispatchId: "boot-plain-running", startedAt: 1_000, status: "running", goal: "Explain why the sky looks blue during the day", reached: null },
  { dispatchId: "boot-finished", startedAt: 1_000, status: "completed", goal: "Explain why the sky looks blue during the day", reached: true, executionId: "walk-satisfier-old" },
]);
interface Res { exposed: boolean; mode: string; records: Record<string, { status: unknown; reached: unknown }>; storeAfter: string; refused: string[]; error?: string }

async function run(mode: "boot" | "import"): Promise<Res> {
  const home = mkdtempSync(join(tmpdir(), "boot-restore-"));
  try {
    const store = join(home, "goal-host-dispatches.json");
    writeFileSync(store, SEED);
    const p = Bun.spawn([process.execPath, CHILD, mode], { cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home, NODE_ENV: "test", TZ: "UTC", GOAL_HOST_DISPATCH_STORE_PATH: store }, stdout: "pipe", stderr: "pipe" });
    const kill = setTimeout(() => p.kill(), 60_000);
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(kill);
    const line = stdout.split("\n").find((l) => l.startsWith(MARK));
    if (!line) throw new Error(`the child printed no result (rc ${p.exitCode}): ${stderr.slice(-800)}`);
    return JSON.parse(line.slice(MARK.length)) as Res;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("MUST-FAIL: the restore is a boot step the service calls, and a replayed boot restores a seeded store", () => {
  test("calling restoreDispatchStoreAtBoot loads the seeded store (a running record and a finished one)", async () => {
    const r = await run("boot");
    expect(r.error).toBeUndefined();
    expect(r.exposed).toBe(true);
    expect(r.records["boot-finished"]).toEqual({ status: "completed", reached: true });
    expect(r.records["boot-plain-running"]).toEqual({ status: "running", reached: null });
  }, 70_000);

  test("the service calls it once, inside its boot block, where the inline restore ran (before the store persists)", () => {
    const main = SRC.indexOf("\nif (import.meta.main) {\n");
    const call = SRC.indexOf("\nawait restoreDispatchStoreAtBoot();\n");
    expect(main).toBeGreaterThan(-1);
    expect(SRC.split("await restoreDispatchStoreAtBoot();").length - 1).toBe(1);
    expect(call).toBeGreaterThan(main);
    expect(call).toBeLessThan(SRC.indexOf("setInterval(persistDispatchStore, 5000);", main));
    expect(SRC.indexOf("satisfierTraceSink.start();", main)).toBeLessThan(call);
  });

  test("the verdict-diff child replays boot through it", () => {
    const child = readFileSync(join(import.meta.dir, "judge-split", "verdict-diff", "child.ts"), "utf8");
    expect(child).toContain('if (mod.__vd_restoreDispatchStoreAtBoot) await drivePromise(mod.__vd_restoreDispatchStoreAtBoot(), "boot:dispatch-store-restore");');
  });
});

describe("CONTROL: an importer still restores nothing (import-safety C1'/C2')", () => {
  test("importing index.ts without the boot call leaves the store empty and the file untouched, with no fetch", async () => {
    const r = await run("import");
    expect(r.error).toBeUndefined();
    expect(r.records).toEqual({});
    expect(r.storeAfter).toBe(SEED);
    expect(r.refused).toEqual([]);
  }, 70_000);
});
