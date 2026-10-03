/**
 * GOAL-HOST HONOURS THE PULL-SYNC QUIESCE MARKER.
 *
 * substrate-pull-sync quiesces a vessel before restarting it by touching
 * $QUIESCE_DIR/<vessel> (default /workspace/quiesce) and then waits for /health
 * in_flight to fall to zero. That only terminates if the vessel stops ADMITTING
 * new long-running work while the marker is there. development-vessel honours it.
 * goal-host published drain_ms (which is what makes pull-sync quiesce it at all)
 * but never read the marker, so new walks kept arriving during its own quiesce
 * and the restart landed on them anyway.
 *
 * Checks:
 *   - freshness: the marker closes admission only while fresh (same rule as
 *     development-vessel: mtime younger than QUIESCE_MAX_MS, default 20 min). A
 *     stale or absent marker fails open;
 *   - admission semantics: marker present → a NEW walk is refused 503, retryable,
 *     with Retry-After. A walk admitted before the marker runs to completion.
 *     Removing the marker restores admission;
 *   - wiring: handleRunGoal (POST /run-goal, and goalDispatchAsync, which
 *     forwards into it) consults the gate beside `draining`, before reading the
 *     body.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const MODULE = join(SRC, "quiesce.ts");

let dir = "";
let marker = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gh-quiesce-"));
  marker = join(dir, "goal-host-vessel");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("quiesce: marker freshness (development-vessel's rule)", () => {
  test("the gate module exists (index.ts cannot be imported in a test: its top level boots the host)", () => {
    expect(existsSync(MODULE)).toBe(true);
  });

  test("MUST-FAIL: a fresh marker quiesces; an absent one does not", async () => {
    const { quiesced } = await import(MODULE);
    expect(quiesced({ marker })).toBe(false);
    writeFileSync(marker, "");
    expect(quiesced({ marker })).toBe(true);
  });

  test("a stale marker (older than QUIESCE_MAX_MS) fails open: a dead converger cannot wedge admission", async () => {
    const { quiesced } = await import(MODULE);
    writeFileSync(marker, "");
    const old = (Date.now() - 21 * 60_000) / 1000;
    utimesSync(marker, old, old);
    expect(quiesced({ marker })).toBe(false);                       // default 20 min bound
    expect(quiesced({ marker, maxMs: 30 * 60_000 })).toBe(true);   // bound is configurable
  });

  test("the default marker is $QUIESCE_DIR/goal-host-vessel, the path pull-sync writes", async () => {
    const { quiesced } = await import(MODULE);
    const prev = { d: process.env.QUIESCE_DIR, m: process.env.GOAL_HOST_QUIESCE_MARKER };
    delete process.env.GOAL_HOST_QUIESCE_MARKER;
    process.env.QUIESCE_DIR = dir;
    try {
      expect(quiesced()).toBe(false);
      writeFileSync(marker, "");
      expect(quiesced()).toBe(true);
    } finally {
      if (prev.d === undefined) delete process.env.QUIESCE_DIR; else process.env.QUIESCE_DIR = prev.d;
      if (prev.m !== undefined) process.env.GOAL_HOST_QUIESCE_MARKER = prev.m;
    }
  });
});

describe("quiesce: admission semantics", () => {
  test("MUST-FAIL: marker present → a new walk is refused retryably; in-flight walk completes; marker removed → admitted", async () => {
    const { quiesceRefusal } = await import(MODULE);
    // A minimal host shaped like handleRunGoal: consult the gate at admission,
    // then start a long walk. The walk is a promise we settle by hand.
    const walks: Array<{ id: number; done: Promise<string>; finish: (v: string) => void }> = [];
    const admit = async (): Promise<Response> => {
      const refusal = quiesceRefusal({ marker });
      if (refusal) return refusal;
      let finish!: (v: string) => void;
      const done = new Promise<string>((r) => { finish = r; });
      walks.push({ id: walks.length, done, finish });
      return Response.json({ dispatchId: walks.length - 1, status: "running" }, { status: 202 });
    };

    // A: admitted with no marker
    const a = await admit();
    expect(a.status).toBe(202);
    expect(walks.length).toBe(1);

    // quiesce opens
    writeFileSync(marker, "");
    const b = await admit();
    expect(b.status).toBe(503);
    expect(b.headers.get("retry-after")).toBe("30");
    const bj = (await b.json()) as Record<string, unknown>;
    expect(bj.error).toBe("quiesced");
    expect(bj.retryable).toBe(true);
    expect(walks.length).toBe(1); // nothing new started

    // the in-flight walk is not interrupted by the marker: it finishes normally
    walks[0]!.finish("reached");
    expect(await walks[0]!.done).toBe("reached");

    // quiesce lifted
    rmSync(marker);
    const c = await admit();
    expect(c.status).toBe(202);
    expect(walks.length).toBe(2);
  });
});

describe("quiesce: wiring into goal-host's admission point", () => {
  test("MUST-FAIL: handleRunGoal consults quiesceRefusal beside the draining check, before reading the body", () => {
    const src = readFileSync(join(SRC, "index.ts"), "utf8");
    const start = src.indexOf("async function handleRunGoal(req: Request): Promise<Response> {");
    expect(start).toBeGreaterThan(-1);
    const bodyRead = src.indexOf("await req.json()", start);
    const head = src.slice(start, bodyRead);
    expect(head.includes("if (draining)")).toBe(true);
    expect(/quiesceRefusal\s*\(/.test(head)).toBe(true);
    expect(/import\s*\{[^}]*\bquiesceRefusal\b[^}]*\}\s*from\s*["']\.\/quiesce(?:\.js)?["']/.test(src)).toBe(true);
  });

  test("goalDispatchAsync still forwards into handleRunGoal (so the async path inherits the gate)", () => {
    const src = readFileSync(join(SRC, "index.ts"), "utf8");
    const i = src.indexOf('type === "goal_dispatch_async" || type === "goalDispatchAsync"');
    expect(i).toBeGreaterThan(-1);
    const tail = src.slice(i, src.indexOf('if (type === "activeDispatches")', i));
    expect(tail.includes("return handleRunGoal(")).toBe(true);
  });
});
