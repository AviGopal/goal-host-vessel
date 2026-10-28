import { describe, it, expect } from "bun:test";

// This check imports the module under test dynamically to allow setting env before it loads
async function importMod() {
  // Avoid side-effect init errors when loading src/index.ts in tests
  if (!process.env["LLM_VESSEL_ENDPOINT"]) process.env["LLM_VESSEL_ENDPOINT"] = "http://127.0.0.1:8220";
  const mod = await import("../../src/index.ts");
  return mod as unknown as Record<string, unknown>;
}

function withPatchedFetch<T>(impl: (info: unknown, init?: unknown) => Promise<Response>, f: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  // @ts-expect-error - we intentionally replace fetch for this test scope
  globalThis.fetch = impl as typeof globalThis.fetch;
  return f().finally(() => {
    // @ts-expect-error - restore fetch
    globalThis.fetch = original as typeof globalThis.fetch;
  });
}

function goalPathFetch(status: number) {
  return async (info: unknown, init?: unknown): Promise<Response> => {
    const url = typeof info === "string" ? info : (typeof info === "object" && info !== null && "url" in info ? String((info as { url: unknown }).url) : "");
    // Intercept the goal-path write; everything else gets a harmless 200 {} so the call sites proceed
    if (/goal[-_]?path/i.test(url)) {
      return new Response("", { status });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

describe("goal-path recording", () => {
  it("[MUST-FAIL] a goal-path POST answering 500 leaves goalPathRecorded=false and logs refusal (correct value: false)", async () => {
    const mod = await importMod();

    // Capture logs emitted by the module under test
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      try { logs.push(args.map((x) => String(x)).join(" ")); } catch { /* best-effort */ }
      // also forward to original to avoid hiding output during local runs
      origLog.apply(console, args as []);
    };

    try {
      await withPatchedFetch(goalPathFetch(500), async () => {
        // Reset the sink if reachable via dispatchContext (the code under test writes to it)
        const dc = mod["dispatchContext"] as Record<string, unknown> | undefined;
        const sink = dc && typeof dc === "object" ? (dc as Record<string, unknown>)["learningSink"] as Record<string, unknown> | undefined : undefined;
        if (sink && typeof sink === "object") {
          (sink as Record<string, unknown>)["goalPathRecorded"] = false;
        }

        // Drive the path that delivers a reach verdict, which in turn triggers the goal-path write
        const deliver = mod["deliverReachVerdict"] as unknown;
        expect(typeof deliver).toBe("function");
        // executionId: string | undefined, reached: unknown, completionShapes: string[] | null | undefined, origin: string
        await (deliver as (a?: string, b?: unknown, c?: string[] | null, d?: string) => Promise<unknown>)("exec-check-500", true, [], "test-check");

        // EXPECTED (after fix): a 500 refusal must not claim recorded; it should remain false
        const recorded = (dc && typeof dc === "object" && sink && typeof sink === "object") ? (sink as Record<string, unknown>)["goalPathRecorded"] : undefined;
        expect(recorded).toBe(false);
        // EXPECTED (after fix): refusal is observable in logs (status code or refusal)
        expect(logs.some((l) => /\b(500|refus|declin)/i.test(l))).toBe(true);
      });
    } finally {
      console.log = origLog;
    }
  });

  it("control: persistWithinDeadline resolves to true for an already-settled persist promise", async () => {
    const mod = await importMod();
    const pwd = mod["persistWithinDeadline"] as (p: Promise<void>, ms: number, id: string) => Promise<boolean>;
    expect(typeof pwd).toBe("function");
    const ok = await pwd(Promise.resolve(), 25, "trace-ctl-1");
    expect(ok).toBe(true);
  });
});
