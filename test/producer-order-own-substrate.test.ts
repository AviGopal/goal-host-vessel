// Own substrate first among remote producers. A compose node's walk resolves of its landing shapes went to the
// federation front first in discovery order and were refused with 401 (measured 2026-10-15), while a sibling node
// of the same substrate serves the shape and accepts the node's key. The substrateNodes pool record lists this
// substrate's discovery origins; a peer row reached through one of them is tried first.
import { describe, expect, test } from "bun:test";
import { buildShapeProducerCache, orderProducers } from "../src/producer-order";

const peer = (id: string, peerEndpoint: string) => ({ id, discoveredVia: "peer", peerEndpoint, endpoint: `http://${id}:8080`, resolve_endpoint: "/v2/impulses/resolve" });
const hubRow = peer("hub", "https://hub.example:8443");
const ownRow = peer("sib", "http://sibling:8100");
const local = { id: "loc", endpoint: "http://127.0.0.1:8080", origin: "local" };

describe("orderProducers with this substrate's own peers", () => {
  test("[MUST-FAIL] a peer row reached through an own-substrate discovery comes before a federation peer's", () => {
    expect(orderProducers([hubRow, ownRow], new Set(["http://sibling:8100"])).map((r) => r.id)).toEqual(["sib", "hub"]);
  });
  test("an own-substrate origin given with a path or trailing slash still matches (origin compare)", () => {
    expect(orderProducers([hubRow, peer("sib", "http://SIBLING:8100/")], new Set(["http://sibling:8100"]))[0]!.id).toBe("sib");
  });
  test("[CONTROL] no set, or an empty set: discovery order kept", () => {
    expect(orderProducers([hubRow, ownRow]).map((r) => r.id)).toEqual(["hub", "sib"]);
    expect(orderProducers([hubRow, ownRow], new Set()).map((r) => r.id)).toEqual(["hub", "sib"]);
  });
  test("[CONTROL] local rows still come first with an own-substrate set", () => {
    expect(orderProducers([hubRow, ownRow, local], new Set(["http://sibling:8100"]))[0]!.id).toBe("loc");
  });
  test("[MUST-FAIL] the shape cache orders a shape's rows with the own-substrate set", () => {
    const rows = [{ ...hubRow, shapes: ["x"] }, { ...ownRow, shapes: ["x"] }];
    expect(buildShapeProducerCache(rows, new Set(["http://sibling:8100"])).get("x")!.map((r) => r.id)).toEqual(["sib", "hub"]);
    expect(buildShapeProducerCache(rows).get("x")!.map((r) => r.id)).toEqual(["hub", "sib"]);
  });
});
