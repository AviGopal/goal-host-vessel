import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

/**
 * Repro: No credit rule distinguishes a pathway body that was replayed (V‑A) from one that re-executed (V‑B).
 * If V‑A carry replay lands without one, every replay re-credits the donor run's arms.
 *
 * We exercise credit-carrier selection via the public export:
 *   chargeChainCarrier(dispatchId, chainExecIds, durableChain, durableGraded, compositeRecorded)
 * and assert the INTENDED behavior (design 01 §3.6): a replayed body must NOT re-credit the donor run.
 *
 * The assertion fails today because the current implementation re-credits along the durable chain.
 */
describe("carry replay V-A credit policy", () => {
  it("does not re-credit donor run's arms when the body is replayed from recorded results", () => {
    // Simulate a replay: the current run's composition chain excludes the donor execution id.
    const donorExec = "exec-donor-9c9b";
    const chainExecIds = ["exec-now-a1", "exec-now-b2"] as const;

    // The durable chain (recorded earlier) still contains the donor execution id.
    const durableChain = [...chainExecIds, donorExec];

    // compositeRecorded=true (the replay produces a recorded composite), durableGraded=false (fresh grading decision path).
    const res = mod.chargeChainCarrier("dispatch-zz", chainExecIds, durableChain, false, true);

    // Ideal (design 01 §3.6): on V-A replay the body's arms receive no new alpha/beta.
    // Therefore, the donor execution id MUST NOT be credited.
    expect(res.durable).not.toContain(donorExec);
  });
});
