// Wiring for producer-order-own-substrate.test.ts: the registry cache fill and endpointForShape's discovery
// pick order with this substrate's own peers, read from the substrateNodes pool record. Source-level.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

describe("[MUST-FAIL] the walk orders producers with the substrateNodes record", () => {
  test("the reader reads the substrateNodes pool record", () => {
    expect(src).toMatch(/async function ownSubstratePeers\(\)[\s\S]{0,900}shape: "substrateNodes"/);
  });
  test("the registry cache is filled in own-substrate order", () => {
    expect(src).toContain("buildShapeProducerCache(vessels, await ownSubstratePeers())");
  });
  test("the discovery pick passes the own-substrate set", () => {
    expect(src).toContain("orderProducers(vessels, own)");
  });
});
