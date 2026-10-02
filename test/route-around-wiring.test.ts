// V6 WIRING (source pins on index.ts; the walk itself is a closure that cannot run without the fleet).
// The record is emitted AT the stall, carried on the walk result, mirrored onto the dispatch record
// that goalWalkState serves, and every caller acting on a stall names its route on it.
import { describe, expect, test } from "bun:test";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;

describe("route-around record", () => {
  test("emitted at the no-pick stall, before the walk breaks", () => {
    const i = src.indexOf("walk: no pick — missing shapes [");
    const j = src.indexOf("routeAround = buildRouteAround({", i);
    const k = src.indexOf("break;", i);
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(k).toBeGreaterThan(j);
    expect(src.slice(j, k)).toContain("appendRouteAround(opts.variables.dispatch_id, routeAround)");
  });
  test("failed producers are captured where satisfiers and picks fail", () => {
    expect(src).toContain('if (!resolved || _emptyRead) satisfierFailures.set(satisfiableNow');
    expect(src).toContain('pickFailures.set(pick.id, "template unfetchable")');
    expect(src).toContain("pickFailures.set(pick.id, `runTemplate threw:");
  });
  test("the walk result carries it and goalWalkState serves it", () => {
    expect(src).toContain("...(routeAround ? { routeAround } : {}),");
    expect(src).toContain("routeArounds: (rec as { routeArounds?: RouteAroundRecord[] }).routeArounds ?? []");
  });
  test("each route around a stall is named: re-frame, satisfier retry, feedback retry, the floor", () => {
    for (const r of ['"reframe"', '"retry:satisfier-suppressed"', '"retry:feedback"', '"universal-tool-fallback"']) {
      expect(src).toContain(`noteRouteTaken(walk.routeAround, ${r})`);
    }
    const n = src.indexOf('noteRouteTaken(walk.routeAround, "universal-tool-fallback")');
    expect(src.slice(n, n + 300)).toContain("const uf = await universalToolFallback(");
  });
  test("must-fail control: a REUSE floor is recorded as floor_as_pathway, never as a stall", () => {
    const n = src.indexOf('kind: "floor_as_pathway"');
    expect(n).toBeGreaterThan(0);
    expect(src.slice(n, n + 400)).toContain("const reused = await universalToolFallback(");
  });
  test("must-fail control: an early edit-intent dispatch routes to feature_compose before any walk (no stall to record)", () => {
    const early = src.indexOf("EARLY EDIT-INTENT DETECTED (pre-walk");
    const firstWalk = src.indexOf("let walk = await runGoalAsPoolWalk(goal, {");
    expect(early).toBeGreaterThan(0);
    expect(firstWalk).toBeGreaterThan(early);
  });
});

describe("qa follow-ups (source)", () => {
  test("a satisfier that returned null before any rawResolve does not inherit the previous shape's reason", () => {
    expect(src).toContain("rawResolveSeq !== seqBefore ? (lastRawResolveReason ?? \"resolver returned nothing\") : \"no resolve attempted");
    expect(src).toContain("satisfierFailures.set(satisfiableNow, _emptyRead ?? resolveFailureSince(_seqBefore))");
    expect(src).toContain("satisfierFailures.set(missingShape, resolveFailureSince(_vrSeqBefore))");
  });
  test("the stall record is scrubbed with this process's own credential", () => {
    expect(src).toContain('termination: walkTerminationReason ?? "no pick", secrets: [API_KEY],');
  });
});
