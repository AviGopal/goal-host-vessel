// ON SIGTERM, THE COUNTED LIFECYCLE-SUBSCRIBER RUNS ARE SENT BEFORE THE PROCESS EXITS (CHANGE DB1).
//
//   [MUST-FAIL] gracefulShutdown awaits host.flushSubscriberCounts() after the drain and before exit.
//   [CONTROL]   the call is optional (a dist without the counter) and cannot throw out of the shutdown.
// Source pin: importing src/index.ts reads the live dispatch store and arms timers.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const shutdown = SRC.slice(SRC.indexOf("async function gracefulShutdown("), SRC.indexOf('process.on("SIGTERM"'));

describe("shutdown flushes the subscriber counts", () => {
  it("[MUST-FAIL] gracefulShutdown awaits flushSubscriberCounts after the drain, before exit", () => {
    const at = shutdown.indexOf(".flushSubscriberCounts?.()");
    expect(at).toBeGreaterThan(shutdown.indexOf("for (;;)"));
    expect(at).toBeLessThan(shutdown.indexOf("process.exit(0)"));
    expect(shutdown).toContain("const sc = await (host as unknown as");
  });
  it("[CONTROL] the call is optional and guarded", () => {
    expect(shutdown).toMatch(/try \{\s*const sc = await[\s\S]*?flushSubscriberCounts\?\.\(\);[\s\S]*?\} catch \{/);
  });
});
