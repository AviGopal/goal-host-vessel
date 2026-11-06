import { describe, it, expect } from "bun:test";
import * as mod from "../../src/producer-order";

type Row = mod.ProducerRow & {
  id?: string;
  vesselId?: string;
  protocol?: string;
  endpoint?: string;
  discoveredVia?: string;
  peerEndpoint?: string;
  libp2p_multiaddr?: string[];
};

describe("concept-db route selection", () => {
  it("regression: a joined spoke prefers a relay over a hub's peer-discovered HTTP row (should pick relay)", () => {
    // Peer-discovered hub row (HTTP), discovered via an own-substrate peer; endpoint is loopback-bound.
    const hubHttp: Row = {
      id: "concept-db@hub-a",
      vesselId: "concept-db@hub-a",
      protocol: "http",
      endpoint: "http://127.0.0.1:7777",
      discoveredVia: "peer",
      peerEndpoint: "http://substrate-a:8443/discovery"
    };

    // Relay alternative, available via libp2p.
    const relay: Row = {
      id: "concept-db@hub-a",
      vesselId: "concept-db@hub-a",
      protocol: "libp2p",
      endpoint: "",
      discoveredVia: "peer",
      peerEndpoint: "http://substrate-b:8443/discovery",
      libp2p_multiaddr: ["/dns4/relay.example/tcp/15002/p2p/12D3KooWabcdef"]
    };

    const picked = mod.pickConceptDbRow([hubHttp, relay], new Set<string>(["http://substrate-a:8443"]));
    // Desired behavior after fix: prefer the relay over a peer-discovered HTTP hub endpoint.
    expect(picked?.via).toBe("relay");
  });

  it("control: a genuine local concept-db HTTP row beats relay (should pick local http)", () => {
    const local: Row = {
      id: "concept-db@self",
      vesselId: "concept-db@self",
      protocol: "http",
      endpoint: "http://127.0.0.1:9000",
      discoveredVia: "local"
    };

    const relayAlt: Row = {
      id: "concept-db@self",
      vesselId: "concept-db@self",
      protocol: "libp2p",
      endpoint: "",
      discoveredVia: "peer",
      peerEndpoint: "http://substrate-c:8443/discovery",
      libp2p_multiaddr: ["/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWxyzxyz"]
    };

    const picked = mod.pickConceptDbRow([relayAlt, local], new Set<string>());
    expect(picked?.via).toBe("http");
    expect(picked?.row).toBe(local);
  });
});
