// THE DURABLE PERSIST THE WALK AWAITS IS BOUNDED BY THE SHAPED FLUSH DEADLINE (OP-1 c-fix, qa review).
//
// OP-1 c made the walk await persistSatisfierTrace(durableTrace) so the walk-complete /reach no longer races the
// insert. That await was bounded only by TranslatingTraceSink.postWithRetry: 3 attempts × AbortSignal.timeout(120000)
// plus backoff, ≈ 367 s worst case. On a spoke whose trace store is on the hub, a slow hub would stall every
// satisfier-last walk for ~6 minutes and time out sync run_goal callers.
//
// THE RULE PINNED HERE: the walk waits at most the shaped selection-tuning satisfierFlushDeadlineMs (20 s default,
// the same deadline every satisfier flush uses); past it the walk continues and a miss line is logged. The insert is
// not cancelled.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realFetch = globalThis.fetch;
let mod: Record<string, any>;
beforeAll(async () => {
  globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  mod = (await import("../src/index")) as Record<string, any>;
  globalThis.fetch = realFetch;
});

describe("MUST-FAIL — a sink that never resolves cannot hold the walk past the deadline", () => {
  test("persistWithinDeadline returns false within the deadline and logs the miss", async () => {
    expect(typeof mod.persistWithinDeadline).toBe("function");
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try {
      const t0 = Date.now();
      const ok = await mod.persistWithinDeadline(new Promise<void>(() => { /* a sink that never resolves */ }), 50, "walk-satisfier-9-1");
      const took = Date.now() - t0;
      expect(ok).toBe(false);
      expect(took).toBeLessThan(1_000);
      expect(logged.some((l) => l.includes("walk-satisfier-9-1") && l.includes("NOT persisted within 50ms"))).toBe(true);
    } finally { console.warn = warn; }
  });

  test("CONTROL: a persist that settles in time returns true and logs nothing", async () => {
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try {
      expect(await mod.persistWithinDeadline(Promise.resolve(), 1_000, "walk-satisfier-9-2")).toBe(true);
      expect(await mod.persistWithinDeadline(Promise.reject(new Error("x")), 1_000, "walk-satisfier-9-3")).toBe(true);
      expect(logged.filter((l) => l.includes("NOT persisted"))).toEqual([]);
    } finally { console.warn = warn; }
  });

  test("wiring: the walk's durable persist goes through it with the shaped satisfierFlushDeadlineMs, and is never awaited bare", () => {
    const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
    const i = SRC.indexOf("if (satisfierOnlyTrace) {");
    const block = SRC.slice(i, i + 6000);
    expect(block).toContain("await persistWithinDeadline(persistSatisfierTrace(durableTrace), (await resolveSelectionTuning()).satisfierFlushDeadlineMs, durableTrace.id);");
    expect(SRC).not.toMatch(/await persistSatisfierTrace\(durableTrace\)/);
  });
});
