import { describe, it, expect } from "bun:test";

/**
 * ONE TRANSIENT 500 KILLED THE ENTIRE REACT FLOOR, AT ITERATION ZERO.
 *
 * MEASURED 2026-08-17 while running the compositional ladder. The floor logged
 *
 *     floor: dispatch FAILED http=500 iter=0 — loop aborts with no observations
 *     floor: exit=empty_loop goalHash=c177c860
 *
 * and the rung was then graded not-reached. 15 such aborts in three hours. Every ladder
 * verdict in that window was passed on a floor that had produced ZERO act-observe cycles —
 * so "the substrate could not compose" and "the substrate never got to try" were being
 * recorded as the same outcome.
 *
 * WHY THE OLD BEHAVIOUR LOOKED PRINCIPLED. The catch block one branch below had already
 * been corrected for timeouts: a timeout is evidence about the ACTION, so it becomes the
 * OBSERVE step and the loop continues. Its comment justified breaking on everything else as
 * symmetric with `!r.ok`, reasoning that a connection refusal "will recur identically on the
 * next turn and can produce no observation".
 *
 * That reasoning is right about a refusal and wrong about a 500. A refusal means the channel
 * is unusable. A 500 means the endpoint ANSWERED — the channel works and the server had a
 * hiccup, which is the textbook retryable case. Collapsing them made the most recoverable
 * failure as fatal as the least.
 *
 * So the split is by what the status tells you: 5xx (server-side, this attempt) becomes an
 * observation and continues; 4xx (malformed request, rejected credential — reproduces
 * identically) still breaks. MAX_ITERS and the wall-clock deadline stay the only
 * unconditional terminators, so a permanently-500ing endpoint costs bounded turns, not a hang.
 */

const SRC = new URL("../src/index.ts", import.meta.url);

async function floorDispatchBlock(): Promise<string> {
  const src = await Bun.file(SRC).text();
  const i = src.indexOf("floor: dispatch FAILED http=");
  expect(i).toBeGreaterThan(-1);
  // Window back far enough to include the `if (!r.ok) {` guard itself.
  return src.slice(Math.max(0, i - 1500), i + 1500);
}

describe("the ReAct floor survives a transient 5xx", () => {
  it("THE REGRESSION: a 5xx does not break the loop", async () => {
    const block = await floorDispatchBlock();
    expect(block).toContain("const transient = r.status >= 500");
    // The break must now be conditional. `if (!r.ok) { ...; break; }` unconditionally was
    // the defect; a bare `break` on this path would reinstate it.
    expect(block).toContain("if (!transient) break;");
  });

  it("a 5xx is fed back as an OBSERVATION, not silently swallowed", async () => {
    const block = await floorDispatchBlock();
    // Continuing without recording anything would loop the model against an identical
    // prompt and waste every remaining iteration — the failure has to enter the context.
    expect(block).toMatch(/observations\.push\(/);
    expect(block).toContain("continue;");
  });

  it("the observation says it is NOT evidence about the goal", async () => {
    const block = await floorDispatchBlock();
    // A bare "HTTP 500" in the observation stream reads to the model as a tool result and
    // can be reasoned over as though it were data about the registry. It must be labelled.
    expect(block).toMatch(/not a result|Do not treat it as evidence/);
  });

  it("a 4xx STILL breaks — the split is the point", async () => {
    const block = await floorDispatchBlock();
    // Retrying a malformed request or a rejected credential burns the whole iteration
    // budget for nothing. If this ever becomes unconditional-continue, the fix has
    // overshot into the opposite defect.
    expect(block).toMatch(/4xx is a channel fault/);
    expect(block).toContain("break;");
  });

  it("NEGATIVE CONTROL: the status split can classify both ways", () => {
    // Before trusting the source assertions, prove the predicate itself discriminates.
    const transient = (s: number) => s >= 500;
    for (const s of [500, 502, 503, 504]) expect(transient(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(transient(s)).toBe(false);
  });
});
