// OBSERVE IS SIDE-EFFECT-FREE — THE REMAINING WRITES (follow-ups to observe-mode-wiring.test.ts). Each block names a
// write an observe dispatch still made after the first pass, read on the source: index.ts boots a server on import, so
// its side-effect functions are pinned on the source, and the pure parts are called through observe-mode.ts (imported
// as a namespace, so a missing export reads as a named failure rather than a link error).
// Controls: the learn path keeps its write after the guard (the guard is observeSkip, whose learn/absent answer is
// false: observe-mode.test.ts (b)), and the pure helpers leave a learn dispatch's data unchanged.
import { describe, expect, test } from "bun:test";

import * as om from "../src/observe-mode";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const fnBody = (sig: string, span = 2500): string => {
  const i = src.indexOf(sig);
  expect(i).toBeGreaterThan(0);
  return src.slice(i, i + span);
};

describe("B1 alpha credit: creditReachedTemplate POSTs no α under observe", () => {
  test("[MUST-FAIL] the observe guard is its first statement, before the credit hold and the feedback POST", () => {
    const body = fnBody("async function creditReachedTemplate(", 3000);
    const guard = body.indexOf('if (observeSkip("alpha_credit")) return { templateId: activityId, dAlpha: 0, dBeta: 0 };');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(body.indexOf("creditHold.heldForGoal("));
    expect(guard).toBeLessThan(body.indexOf("/v2/activities/feedback"));
  });
  test("control (learn): the positive feedback POST is still there, and both call sites still credit", () => {
    const body = fnBody("async function creditReachedTemplate(", 3000);
    expect(body).toContain('direction: "positive", intensity: 2');
    expect(src.match(/await creditReachedTemplate\(/g)?.length).toBe(2);
  });
});
