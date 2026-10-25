// EVERY `bun test` PROCESS IN THIS TREE STARTS WITH THE DISPATCH STORE AT A TEMP FILE (test/setup-dispatch-store-isolation.ts,
// preloaded by bunfig.toml). A per-file redirect is set too late when another file imported src/index.ts first, and
// fixture dispatches were persisted over the live /workspace/goal-host-dispatches.json.
//
// The probe runs in a CHILD `bun test` from the repo root with a minimal environment (no GOAL_HOST_DISPATCH_STORE_PATH,
// as in any unscrubbed run; TMPDIR is passed so both sides agree on the temp root). It imports nothing from src/, so on the parent tree (no preload) it reports "(unset)" and
// nothing is written anywhere; with the preload it reports a temp path. Output goes to a temp FILE (a pipe can truncate).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

async function childStorePath(env: Record<string, string>): Promise<string> {
  const out = join(mkdtempSync(join(tmpdir(), "dispatch-store-isolation-")), "out.txt");
  const p = Bun.spawn([process.execPath, "test", "./test/fixtures/dispatch-store-path-probe.test.ts"], {
    cwd: ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1", TMPDIR: tmpdir(), ...env },
    stdout: Bun.file(out), stderr: Bun.file(out + ".err"),
  });
  await p.exited;
  const text = readFileSync(out, "utf8") + readFileSync(out + ".err", "utf8");
  return /STORE_PATH (\S+)/.exec(text)?.[1] ?? `(no probe line: ${text.slice(0, 300)})`;
}

describe("the dispatch store path a test process starts with", () => {
  test("[MUST-FAIL] an unscrubbed `bun test` (no store path in its env) starts with the store at a temp file, never the live path", async () => {
    const p = await childStorePath({});
    expect(p).not.toBe("(unset)");
    expect(p.startsWith("/workspace/")).toBe(false);
    expect(p.startsWith(tmpdir())).toBe(true);
    expect(p.endsWith("/goal-host-dispatches.json")).toBe(true);
  });
  test("[MUST-FAIL] a store path at the live default is redirected too", async () => {
    const p = await childStorePath({ GOAL_HOST_DISPATCH_STORE_PATH: "/workspace/goal-host-dispatches.json" });
    expect(p.startsWith("/workspace/")).toBe(false);
    expect(p.startsWith(tmpdir())).toBe(true);
  });
  test("[CONTROL] a store path the runner already put outside /workspace is kept", async () => {
    const mine = join(mkdtempSync(join(tmpdir(), "dispatch-store-own-")), "d.json");
    expect(await childStorePath({ GOAL_HOST_DISPATCH_STORE_PATH: mine })).toBe(mine);
  });
});
