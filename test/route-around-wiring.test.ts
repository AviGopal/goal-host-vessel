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
