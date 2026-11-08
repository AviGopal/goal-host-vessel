// T-W2-1 (source form): every place that runs the walk DISPATCHES the walk activity (src/walk-activity.ts) through the
// engine; nothing calls the walk body in process except the walk activity's own resolver body.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
const count = (needle: RegExp): number => SRC.match(needle)?.length ?? 0;
function fnBody(name: string): string {
  const i = SRC.indexOf(`async function ${name}(`);
  if (i < 0) return "";
  const next = SRC.slice(i + 1).search(/\n(?:async )?function [A-Za-z_]+\(/);
  return next < 0 ? SRC.slice(i) : SRC.slice(i, i + 1 + next);
}

describe("T-W2-1: the walk runs only as the walk activity", () => {
  test("MUST-FAIL: no in-process wrapper and no call to it", () => {
    expect(count(/\brunGoalAsPoolWalk\(/g)).toBe(0);
    expect(count(/async function runGoalAsPoolWalk\(/g)).toBe(0);
  });
  test("MUST-FAIL: the walk body is called once, from the walk activity's resolver body", () => {
    const calls = count(/\brunGoalAsPoolWalkBody\(goal, /g);
    expect(calls).toBe(1);
    expect(fnBody("walkActivityBody")).toContain("await runGoalAsPoolWalkBody(goal, { ...opts, parentExecutionId: walk.executionId, compositionChain: [...walk.compositionChain] });");
  });
  test("MUST-FAIL: the dispatcher dispatches the walk four times (first walk + feedback / suppress / reframe retries), each retry parented to the first walk", () => {
    const inner = fnBody("runGoalWithRecoveryInner");
    const calls = inner.split("await dispatchWalk(goal, {").slice(1).map((c) => c.slice(0, c.indexOf("});")));
    expect(calls.length).toBe(4);
    expect(calls[0]).toContain("parentExecutionId: opts.parentExecutionId,");
    for (const c of calls.slice(1)) expect(c).toContain("parentExecutionId: _firstWalkId,");
    for (const kind of ["feedback", "suppress", "reframe"]) expect(inner).toContain(`_retryTap("${kind}", _${kind}WalkId, `);
    expect(inner).toContain("turned_unreached_into_reached=${retry.reached === true}");
  });
  test("dispatchWalk runs the registered record through host.runTemplate with the goal as its input impulse", () => {
    const d = fnBody("dispatchWalk");
    expect(d).toContain("await host.catalogue.getTemplate(WALK_ACTIVITY_ID)");
    expect(d).toContain("host.runTemplate(record, { goal }, { impulses: [goalImpulse(goal, ");
  });
});
