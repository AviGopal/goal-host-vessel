// TWO DELIVERIES OF ONE DISPATCH CHARGE AN ANCESTOR ONCE — THROUGH THE WALK'S OWN CARRIER (OP-1 b, qa review).
//
// one-chain-carrier.test.ts drives the pure chainCarrierChains with a hand-threaded `alreadyCharged` set, so deleting
// the line in index.ts that RECORDS what a dispatch charged (`for (const id of c.charged) charged.add(id)` in
// chargeChainCarrier) survived it. This drives chargeChainCarrier itself — the function the not-reached branch calls,
// keyed by the dispatch id — twice for one dispatch (a walk, then its retry carrying exec_A forward), and models
// activity-api's propagation over the chains it returns: exec_A takes exactly one β. A different dispatch is charged
// independently.
import { beforeAll, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
let charge: (dispatchId: unknown, chainExecIds: string[], durableChain: string[], durableGraded: boolean, compositeRecorded: boolean) => { durable: string[]; composite: string[] };
beforeAll(async () => {
  globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  charge = (await import("../src/index")).chargeChainCarrier as typeof charge;
  globalThis.fetch = realFetch;
});

const LAMBDA = 0.6;
/** β per ancestor from graded carriers' chains (call lineage: λ^depth, depth 1 = closest). */
function betaFrom(chains: string[][]): Map<string, number> {
  const b = new Map<string, number>();
  for (const c of chains) [...c].reverse().forEach((id, i) => b.set(id, (b.get(id) ?? 0) + Math.pow(LAMBDA, i + 1)));
  return b;
}

describe("MUST-FAIL — one dispatch, two deliveries, one ancestor β", () => {
  test("a walk and its retry in the same dispatch charge exec_A exactly once (λ)", () => {
    expect(typeof charge).toBe("function");
    const d = `op1-dispatch-${Date.now()}-a`;
    // Walk 1: [exec_A, sat-2], the durable trace (chain [exec_A]) is the graded carrier.
    const w1 = charge(d, ["exec_A", "walk-satisfier-2-1"], ["exec_A"], true, true);
    // Walk 2 (retry, ADDITIVE): carries exec_A forward, fresh last step sat-3; again the durable trace carries.
    const w2 = charge(d, ["exec_A", "walk-satisfier-3-1"], ["exec_A"], true, true);
    const beta = betaFrom([w1.durable, w1.composite, w2.durable, w2.composite]);
    expect(beta.get("exec_A")).toBeCloseTo(LAMBDA, 10);
  });

  test("CONTROL: a different dispatch is charged on its own", () => {
    const w1 = charge(`op1-dispatch-${Date.now()}-b`, ["exec_B", "walk-satisfier-2-2"], ["exec_B"], true, true);
    const w2 = charge(`op1-dispatch-${Date.now()}-c`, ["exec_B", "walk-satisfier-2-3"], ["exec_B"], true, true);
    expect(betaFrom([w1.durable, w2.durable]).get("exec_B")).toBeCloseTo(2 * LAMBDA, 10);
  });

  test("CONTROL: with no dispatch id the carrier rule still applies, without dedupe", () => {
    const w = charge(undefined, ["exec_C", "walk-satisfier-2-4"], ["exec_C"], true, true);
    expect(w).toEqual({ durable: ["exec_C"], composite: [] });
  });
});
