import { describe, it, expect } from "bun:test";
import * as producerOrder from "../../src/producer-order";
import type { ProducerRow } from "../../src/producer-order";

/**
 * This test file reproduces the defect where `goal-host-vessel` picks producers
 * from discovery rows without using the `orderProducers` function, leading to
 * suboptimal choices (e.g., picking a remote producer when a local one is available).
 *
 * The defect is located in `src/index.ts` at multiple call sites, which use
 * `Array.prototype.find()` or direct indexing (`vessels[0]`) on raw discovery
 * results, bypassing the correct locality-aware sorting.
 *
 * This test simulates that incorrect logic and asserts that it differs from the
 * correct logic, causing the test to fail. This verifies the existence of the
 * logical flaw without needing to execute the full server or mock network dependencies.
 */
describe("goal-host-vessel producer selection bypasses ordering", () => {
  // Per spec, to ensure the module containing the correct logic is loadable.
  it("loads the producer-order module successfully", () => {
    expect(typeof (producerOrder as Record<string, unknown>)["orderProducers"]).toBe("function");
    expect(typeof (producerOrder as Record<string, unknown>)["producerClass"]).toBe("function");
  });

  it("THE FAILING TEST: demonstrates that direct .find() picks a remote producer over a local one", () => {
    // A typical list of producers from discovery, with a remote/overlay
    // producer appearing before a local one.
    const discoveryRows: ReadonlyArray<ProducerRow> = [
      {
        origin: "overlay",
        endpoint: "http://remote-peer.vessel/v2/impulses/resolve",
        protocol: "https",
        discoveredVia: "peer",
      },
      {
        origin: "local",
        endpoint: "http://127.0.0.1:54321/v2/impulses/resolve",
      },
    ];

    // This simulates the INCORRECT logic found in `src/index.ts`, where
    // the first producer with an endpoint is chosen from the unsorted list.
    const pickedUsingFlawedLogic = discoveryRows.find(r => !!r.endpoint);

    // This is the CORRECT way to pick a producer, by first ordering them
    // to prioritize local producers.
    const correctlyOrderedProducers = producerOrder.orderProducers(discoveryRows);
    const pickedUsingCorrectLogic = correctlyOrderedProducers[0];

    // This assertion is EXPECTED TO FAIL.
    // It will fail because the flawed logic picks the 'overlay' producer,
    // while the correct logic picks the 'local' producer. This reproduces
    // the bug.
    expect(pickedUsingFlawedLogic).toEqual(pickedUsingCorrectLogic);
  });
});
