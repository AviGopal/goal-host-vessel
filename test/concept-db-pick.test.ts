// Lesson recall picks the concept-db a node can actually reach: local, then this substrate's own nodes, then the
// federation relay, then a foreign peer. Measured 2026-10-16: the first non-libp2p row in discovery order was a
// federation peer's concept-db re-homed onto a port its firewall drops, so compose and spoke nodes timed out on every
// recall while a sibling node's concept-db answered in milliseconds.
import { describe, expect, test } from "bun:test";
import { pickConceptDbRow } from "../src/producer-order";

const foreign = { id: "concept-db-local", discoveredVia: "peer", peerEndpoint: "https://hub.example:8443", endpoint: "http://hub.example:18260", resolve_endpoint: "/resolve" };
const sibling = { id: "concept-db-local", discoveredVia: "peer", peerEndpoint: "http://sibling:8100", endpoint: "http://sibling:8260", resolve_endpoint: "/resolve" };
const relay = { id: "concept-db", protocol: "libp2p", libp2p_multiaddr: ["/ip4/10.0.0.1/tcp/4001/p2p/QmX"], endpoint: "http://127.0.0.1:8260" };
const local = { id: "concept-db-local", endpoint: "http://127.0.0.1:8260", origin: "local", resolve_endpoint: "/resolve" };
const devVessel = { id: "development-vessel-local", endpoint: "http://localhost:8090", origin: "local" };
const OWN = new Set(["http://sibling:8100"]);

describe("pickConceptDbRow", () => {
  test("[MUST-FAIL] a sibling node's concept-db beats a foreign peer listed first", () => {
    expect(pickConceptDbRow([foreign, sibling, relay], OWN)).toEqual({ via: "http", row: sibling });
  });
  test("[MUST-FAIL] with no own-substrate row, the relay beats a foreign peer's http row", () => {
    expect(pickConceptDbRow([foreign, relay], OWN)).toEqual({ via: "relay", row: relay });
  });
  test("[CONTROL] a local concept-db wins over everything", () => {
    expect(pickConceptDbRow([foreign, sibling, relay, local], OWN)?.row).toBe(local);
  });
  test("[CONTROL] only a foreign peer row exists: it is still used (better than no recall)", () => {
    expect(pickConceptDbRow([foreign], OWN)).toEqual({ via: "http", row: foreign });
  });
  test("[CONTROL] rows not named concept-db are never picked; nothing named → null", () => {
    expect(pickConceptDbRow([devVessel], OWN)).toBeNull();
    expect(pickConceptDbRow([], OWN)).toBeNull();
  });
});
