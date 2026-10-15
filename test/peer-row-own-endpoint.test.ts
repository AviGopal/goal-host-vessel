// A peer row is resolved at its OWN endpoint when discovery re-homed it onto the peer host. Its peerEndpoint is
// the peer's DISCOVERY, which serves no impulse resolve route: measured 2026-10-15, a compose node's walk resolves
// of its landing shapes went to <peer discovery>/v2/impulses/resolve and were answered 404 (a sibling node's
// discovery) and 401 (a federation front validating the caller's key against its own identity).
import { describe, expect, test } from "bun:test";
import { dialsOwnEndpoint } from "../src/producer-order";

const peerRow = (extra: Record<string, unknown> = {}) => ({
  id: "activity-api-local",
  discoveredVia: "peer",
  peerEndpoint: "http://P:8100",
  endpoint: "http://N:8080",
  resolve_endpoint: "/v2/impulses/resolve",
  ...extra,
});

describe("dialsOwnEndpoint", () => {
  test("a re-homed peer row (non-loopback http endpoint) resolves at its own endpoint", () => {
    expect(dialsOwnEndpoint(peerRow())).toBe(true);
    expect(dialsOwnEndpoint(peerRow({ endpoint: "https://n.example:18080" }))).toBe(true);
  });
  test("[CONTROL] a peer row whose endpoint is the peer's own loopback keeps the other branches", () => {
    expect(dialsOwnEndpoint(peerRow({ endpoint: "http://127.0.0.1:8080" }))).toBe(false);
    expect(dialsOwnEndpoint(peerRow({ endpoint: "http://localhost:8080" }))).toBe(false);
  });
  test("[CONTROL] a libp2p row keeps the transport egress", () => {
    expect(dialsOwnEndpoint(peerRow({ protocol: "libp2p" }))).toBe(false);
  });
  test("[CONTROL] a local row, an unparseable endpoint and a missing endpoint are not peer-own routes", () => {
    expect(dialsOwnEndpoint({ endpoint: "http://N:8080", origin: "local" })).toBe(false);
    expect(dialsOwnEndpoint(peerRow({ endpoint: "not a url" }))).toBe(false);
    expect(dialsOwnEndpoint(peerRow({ endpoint: "" }))).toBe(false);
  });
});
