import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

/**
 * Repro: No credit rule distinguishes a pathway body that was replayed (V‑A) from one that re-executed (V‑B).
 * If V‑A carry replay lands without one, every replay re-credits the donor run's arms.
 *
 * We exercise credit-carrier selection via the public export:
 *   chargeChainCarrier(dispatchId, chainExecIds, durableChain, durableGraded, compositeRecorded)
 * and assert the INTENDED behavior (design 01 §3.6): a replayed body must NOT re-credit the donor run,
 * while a re-execution should.
 *
 * The first test fails today because the current implementation re-credits the durable chain on replay.
 */
describe("carry replay credit policy (V-A vs V-B)", () => {
  it("on V-A replay, withholds all durable credit and credits composite chain", () => {
    const donorExec = "exec-donor-9c9b";
    const chainExecIds = ["exec-now-a1", "exec-now-b2"] as const;
    const durableChain = [...chainExecIds, donorExec];

    // V-A replay: compositeRecorded=true, durableGraded=false.
    const res = mod.chargeChainCarrier(
      "dispatch-va-replay",
      chainExecIds,
      durableChain,
      false, // durableGraded
      true // compositeRecorded
    );

    // Ideal (design 01 §3.6): on V-A replay, the body's arms receive no new alpha/beta.
    // The durable credit list should be empty.
    expect(res.durable).toEqual([]);

    // The adaptation outcome (composite chain) IS credited. This should contain the current execution IDs.
    expect(res.composite).toEqual([...chainExecIds]);
  });

  it("CONTROL: on V-B re-execution, credits durable chain including donor", () => {
    const donorExec = "exec-donor-9c9b";
    const chainExecIds = ["exec-now-a1", "exec-now-b2", donorExec] as const;
    const durableChain = [...chainExecIds];

    // V-B re-execution: not a composite replay, reusing durable grading.
    // compositeRecorded=false, durableGraded=true.
    const res = mod.chargeChainCarrier(
      "dispatch-vb-rexec",
      chainExecIds,
      durableChain,
      true, // durableGraded
      false // compositeRecorded
    );

    // On re-execution, credit propagates along the durable chain.
    expect(res.durable).toContain(donorExec);
    // The full durable chain should be credited.
    expect(res.durable).toEqual(expect.arrayContaining(durableChain));
  });
});
