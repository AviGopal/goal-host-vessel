// A shape whose payload must be SYNTHESIZED is unreachable from cold by design, so failing to
// reach it is never evidence of a missing capability.
//
// Measured 2026-08-05: the walk filed `reach-gap-shellresult` while shellResult resolved
// perfectly on demand (`{"stdout":"alive\n","exit_code":0}`). It had simply failed to synthesize
// a command, because the LLM plane was timing out. The gap store held 105 `reach-gap-*` rows
// whose own summaries begin "shape X is advertised by a producer, but…" — the system recorded
// that the capability EXISTS and filed a missing-capability gap anyway.
//
// That is not noise. Those gaps become "Close substrate gap reach-gap-…" goals, and that family
// is the largest and worst-performing in the path store (3,090 executions at 4% reach). A
// transient dependency outage was minting durable work items describing a problem that does not
// exist, which the loop then could not close because there was nothing to close.
//
// The assertion is on the SKIP SET rather than on fileReachabilityGap itself, because that
// function performs discovery and a gap-store write — running it in a test would either need a
// live fleet or a mock deep enough to test the mock. The set IS the decision.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

/** The set as declared in src/index.ts, parsed out so drift shows up as a failure here. */
function declaredExecutorShapes(): string[] {
  const start = SRC.indexOf("const EXECUTOR_ROOTED_SHAPES = new Set([");
  expect(start).toBeGreaterThan(-1);
  const body = SRC.slice(start, SRC.indexOf("]);", start));
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

describe("executor-rooted shapes never file a reachability gap", () => {
  const shapes = declaredExecutorShapes();

  it("covers the universal executor", () => {
    // shellResult is the one measured filing a false gap, and it is the shape the walk falls
    // back to most often — the single highest-volume source of phantom gaps.
    expect(shapes).toContain("shellResult");
  });

  it("covers the LLM shapes, whose payload is a synthesized prompt", () => {
    expect(shapes).toContain("llm_completion");
    expect(shapes).toContain("llm_completion_dispatch");
  });

  it("is consulted inside fileReachabilityGap, before the gap is written", () => {
    const fnStart = SRC.indexOf("async function fileReachabilityGap(");
    const fnBody = SRC.slice(fnStart, SRC.indexOf("\n}", fnStart));
    expect(fnBody).toContain("EXECUTOR_ROOTED_SHAPES.has(shape)");
    // The skip must precede the write, or the gap lands before the check runs.
    expect(fnBody.indexOf("EXECUTOR_ROOTED_SHAPES.has(shape)")).toBeLessThan(fnBody.indexOf("substrateGap_write"));
  });

  // The pre-existing skip for parameter-rooted ACTION shapes must survive — it encodes the same
  // rule for writes, and losing it would reopen the same class from the other side.
  it("keeps the existing parameter-rooted action-shape skip", () => {
    expect(SRC).toContain('shape.endsWith("_write")');
    expect(SRC).toContain("cold-unreachable by design");
  });
});
