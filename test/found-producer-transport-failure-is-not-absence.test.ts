// A PRODUCER THAT WAS FOUND BUT FAILED ON TRANSPORT IS NOT AN ABSENT ONE (CHANGE-36b; RUN 1 attempt 1 pos 13).
//
// The walk resolved gapDecomposition's producer (development-vessel decomposeGap); the call failed on transport, and the
// fallback TEMPLATE lookup (recommendExcluding) then found no template (a resolver is not a template), so the run
// returned "no template produces the inferred target shapes [gapDecomposition]" and escalated as a missing producer
// (contained != absent). The lookupFailed abstain covered recommend failures only. Now the dispatch's route-around
// records are read first: a target shape whose producer failed TRANSIENTLY abstains, with no capability gap.
//
//   [MUST-FAIL] a route-around record whose failed producer for gapDecomposition failed on transport -> that failure is
//               found (the abstain fires); the wiring sits BEFORE the "honest no-producer failure" branch.
//   [CONTROL]   a non-transient failure (a 400 / validation refusal), a different shape, or no records -> nothing (the
//               honest no-producer branch still runs for a real absence).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isTransientFailure } from "../src/transient-failure";
const RA = (await import("../src/route-around")) as Record<string, any>;
const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

const rec = (shape: string, reason: string) => [{ kind: "stall", at: 0, goal_hash: "h", target: [shape], produced: [], missing_producer: [shape], failed_producers: [{ shape, producer: `satisfier:${shape}`, reason }], termination: "stall", route_taken: "stop", routes_taken: [] }];
const transient = (r: string) => isTransientFailure(r);

describe("a found producer that failed on transport is not an absent one", () => {
  it("[MUST-FAIL] a transport failure of gapDecomposition's producer is found", () => {
    expect(typeof RA["transientProducerFailure"]).toBe("function");
    const f = RA.transientProducerFailure(rec("gapDecomposition", "transport: fetch failed (ECONNRESET)"), ["gapDecomposition"], transient);
    expect(f).toMatchObject({ shape: "gapDecomposition", producer: "satisfier:gapDecomposition" });
  });

  it("[CONTROL] a non-transient failure, another shape, or no records: nothing", () => {
    expect(typeof RA["transientProducerFailure"]).toBe("function");
    expect(RA.transientProducerFailure(rec("gapDecomposition", 'HTTP 400: {"error":"pointer.decompose_gap_id is required"}'), ["gapDecomposition"], transient)).toBeNull();
    expect(RA.transientProducerFailure(rec("conceptSequence", "transport: fetch failed"), ["gapDecomposition"], transient)).toBeNull();
    expect(RA.transientProducerFailure(undefined, ["gapDecomposition"], transient)).toBeNull();
  });

  it("[WIRING] the abstain reads this dispatch's route-around records BEFORE the honest no-producer branch", () => {
    const abstain = SRC.indexOf("const _transientProducer = transientProducerFailure(");
    const honest = SRC.indexOf("— honest no-producer failure`);");
    expect(abstain).toBeGreaterThan(0);
    expect(honest).toBeGreaterThan(abstain);
    expect(SRC).toContain("(executionStore.get(String(opts.variables?.dispatch_id ?? \"\")) as { routeArounds?: RouteAroundRecord[] } | undefined)?.routeArounds,");
    expect(SRC).toContain("no capability gap filed`, reached: false };");
  });
});
