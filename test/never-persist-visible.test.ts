// A HOST THAT CANNOT PERSIST ITS DISPATCH STORE CANNOT RUN SILENTLY.
//
// Follow-up to the dispatch-store integrity fix: when the boot finds an unreadable store it cannot move aside, the host
// keeps the file untouched by never persisting, so nothing it records survives a restart. That state is now visible: each
// skipped persist is logged (the first at once, then at most every 10 min), and the host files one gap about itself
// (deterministic id per node, so a re-file upserts the same row).
//
//   [MUST-FAIL] a host in the never-persist state logs NOT DURABLE on its first skipped persist and not again within
//               the window, files exactly one gap, and the file is left as it was
//   [MUST-FAIL] the log rate and the gap row (pure): first skip logs, later skips inside the window do not, the window's
//               end logs again; the gap id is per node
//   [CONTROL]   a normal host (a readable store) files nothing and logs no NOT DURABLE line
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-30T04:01:11Z seed=1793332871368950918
// words=disprove washroom familiar voyage kindly. The index.ts cases run in a CHILD bun process on temp stores
// (hostStateEnv) with the move-aside made to fail by a scoped mock of rename for .corrupt- targets only.
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStateEnv } from "./fixtures/host-state-env";

const D = (await import("../src/dispatch-store-file").catch(() => ({}))) as Record<string, any>;

describe("the log rate and the gap row", () => {
  it("[MUST-FAIL] first skip logs, skips inside the window do not, the window's end logs again; one gap id per node", () => {
    const st = { lastLoggedAt: null, skipped: 0 };
    const at = (t: number) => D["neverPersistLine"]?.(st, t, 600_000, "/tmp/x/goal-host-dispatches.json") ?? null;
    expect(at(0)).toContain("dispatch store NOT DURABLE");
    expect(at(5_000)).toBeNull();
    expect(at(599_999)).toBeNull();
    expect(at(600_000)).toContain("(4 so far)");
    const g = D["neverPersistGap"]?.("washroom-node", "/tmp/x/goal-host-dispatches.json", "Unexpected end of JSON input", new Date(0));
    expect(g?.id).toBe("goal-host-dispatch-store-not-durable-washroom-node");
    expect(g?.status).toBe("open");
    expect(String(g?.summary)).toContain("could not be moved aside");
  });
});

type Out = Record<string, any>;
function probe(mode: "stuck" | "normal"): Out {
  const dir = mkdtempSync(join(tmpdir(), "never-persist-"));
  try {
    const store = join(dir, "goal-host-dispatches.json");
    const body = mode === "stuck" ? '[{"dispatchId":"voyage-1","status":"compl' : JSON.stringify([{ dispatchId: "voyage-1", startedAt: 1, status: "completed" }]);
    writeFileSync(store, body);
    const p = join(dir, "probe.test.ts");
    const src = (f: string) => JSON.stringify(join(import.meta.dir, "..", "src", f));
    writeFileSync(p, `
      import { mock, test } from "bun:test";
      import { readFileSync } from "node:fs";
      const real = await import("node:fs/promises");
      mock.module("node:fs/promises", () => ({ ...real, rename: async (a, b) => { if (String(b).includes(".corrupt-")) throw new Error("EPERM: the move-aside is refused (test)"); return real.rename(a, b); } }));
      test("probe", async () => {
        const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.map(String).join(" "));
        const posts = [];
        globalThis.fetch = (async (u, init) => { const b = String(init?.body ?? ""); if (b.includes("substrateGap_write")) posts.push(JSON.parse(b)); return new Response("{}", { status: 200 }); });
        const m = await import(${src("index.ts")});
        const life = m.__storeLifecycleForTests();
        await life.restore();
        await new Promise((r) => setTimeout(r, 50));
        for (let i = 0; i < 3; i++) await life.persist();
        await new Promise((r) => setTimeout(r, 50));
        console.error = oe;
        process.stdout.write("RESULT " + JSON.stringify({
          writable: life.writable(),
          notDurable: errs.filter((l) => l.includes("dispatch store NOT DURABLE")).length,
          unreadable: errs.filter((l) => l.includes("DISPATCH STORE UNREADABLE at boot")).length,
          gaps: posts.map((x) => x.impulse.pointer.gap.id),
          file: readFileSync(${JSON.stringify(store)}, "utf8"),
        }) + "\\n");
      });
    `);
    const r = Bun.spawnSync([process.execPath, "test", p], {
      cwd: dir,
      env: { HOME: process.env.HOME ?? "/tmp", PATH: process.env.PATH ?? "", NODE_ENV: "test", LLM_VESSEL_ENDPOINT: "http://llm.test.invalid", DEV_VESSEL_ENDPOINT: "http://dev.test", ACTIVITY_API_ENDPOINT: "http://act.test", DISCOVERY_VESSEL_ENDPOINT: "http://127.0.0.1:9", ...hostStateEnv(dir) },
      stdout: "pipe", stderr: "pipe",
    });
    const line = r.stdout.toString().split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`probe produced no result: ${r.stderr.toString().slice(-2000)}`);
    return { ...JSON.parse(line.slice("RESULT ".length)), body };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("the host (child process, temp store)", () => {
  let stuck: Out; let normal: Out;
  beforeAll(() => { stuck = probe("stuck"); normal = probe("normal"); }, 60_000);

  it("[MUST-FAIL] a never-persist host logs NOT DURABLE once in the window, files one gap, and leaves the file as it was", () => {
    expect(stuck.writable).toBe(false);
    expect(stuck.unreadable).toBe(1);
    expect(stuck.notDurable).toBe(1);
    expect(stuck.gaps.length).toBe(1);
    expect(stuck.gaps[0]).toMatch(/^goal-host-dispatch-store-not-durable-/);
    expect(stuck.file).toBe(stuck.body);
  });
  it("[CONTROL] a normal host files nothing and logs no NOT DURABLE line", () => {
    expect(normal.writable).toBe(true);
    expect(normal.notDurable).toBe(0);
    expect(normal.gaps).toEqual([]);
  });
});
