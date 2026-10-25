// Probe for test/dispatch-store-isolation.test.ts: prints the dispatch store path this `bun test` process starts with.
// It imports nothing from src/, so it writes nothing wherever the path points.
import { test } from "bun:test";

test("dispatch store path probe", () => {
  console.log(`STORE_PATH ${process.env["GOAL_HOST_DISPATCH_STORE_PATH"] ?? "(unset)"}`);
});
