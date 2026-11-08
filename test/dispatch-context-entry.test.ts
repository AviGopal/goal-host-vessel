import { afterEach, describe, expect, test } from "bun:test";

import { enterDispatchContext, type DispatchContextStore } from "../src/dispatch-context";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const GAP = "gap-entry-test";
describe("enterDispatchContext", () => {
  test("an undefined never erases a field; observe is sticky; the gap id is set only when absent; goal is the site's", () => {
    const parent: DispatchContextStore = { dispatchId: "d1", decomposeGapId: GAP, learningMode: "observe", goal: "g1" };
    expect(enterDispatchContext(parent, { dispatchId: "d1" })).toEqual(parent);
    expect(enterDispatchContext(parent, { dispatchId: "d1", learningMode: "learn", decomposeGapId: "other", goal: "g2" })).toEqual({ dispatchId: "d1", decomposeGapId: GAP, learningMode: "observe", goal: "g2" });
    expect(enterDispatchContext({ dispatchId: "d1", learningMode: "learn" }, { dispatchId: "d1", learningMode: "observe" }).learningMode).toBe("observe");
    expect(parent).toEqual({ dispatchId: "d1", decomposeGapId: GAP, learningMode: "observe", goal: "g1" });
  });
  test("[CONTROL] an empty store takes the site's fields as given", () => {
    expect(enterDispatchContext(undefined, { dispatchId: "d3", learningMode: "learn", decomposeGapId: GAP })).toEqual({ dispatchId: "d3", learningMode: "learn", decomposeGapId: GAP });
  });
  test("[MUST-FAIL] wiring: every entry in index.ts goes through enterDispatchContext over the existing store", () => {
    expect(src.match(/dispatchContext\.(enterWith|run)\(\{[^\n]{0,80}/g) ?? []).toEqual([]);
    expect(src).toContain('import { enterDispatchContext } from "./dispatch-context";');
  });
});
