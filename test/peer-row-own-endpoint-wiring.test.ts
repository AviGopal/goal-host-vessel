// Wiring for peer-row-own-endpoint.test.ts: both resolve sites in index.ts (the walk's routeFor and the discovery-proxy
// resolver) route a re-homed peer row to its own endpoint BEFORE the branch that sends it to the peer's discovery.
// Source-level (no module import), so it fails on a tree without the rule for that reason alone.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("[MUST-FAIL] both resolve sites check the re-homed endpoint BEFORE the peer-discovery branch", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
  const sites = [
    { name: "walk routeFor", peer: 'if (v.discoveredVia === "peer" && v.peerEndpoint) {' },
    { name: "discovery-proxy", peer: '} else if (v.discoveredVia === "peer" && v.peerEndpoint) {' },
  ];
  for (const site of sites) {
    test(site.name, () => {
      const at = src.indexOf(site.peer);
      expect(at).toBeGreaterThan(0);
      // The nearest preceding branch window (a few hundred chars) must route a re-homed row to its own endpoint.
      const window = src.slice(Math.max(0, at - 700), at);
      expect(window).toContain("dialsOwnEndpoint(v)");
    });
  }
});
