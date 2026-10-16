// REACHABILITY (b, c): THE WALK NEVER DIALS A DEAD EGRESS TWICE, AND A ROUTE THAT REFUSED THIS NODE'S CREDENTIAL IS
// POISONED FOR THE WALK.
//
// Measured 2026-10-16 on a node whose federation transport is masked: the walk's direct satisfier call for
// gapDecomposition picked a libp2p row after one missed local /health probe (relay rows were accepted UNPROBED since
// 3df384a, 07-02) and the transient retry reused the SAME route, refused twice at the dead egress. A libp2p route dials
// this node's own egress (loopback), so it is as probeable as a local row (b). The retry re-picks excluding the route that
// failed, and an auth refusal (401/403: an enforcing hub answering a node-issued credential) poisons THAT route for the
// walk, not the shape (c, qa amendment after the user's transport-unmask ruling).
import { describe, expect, it } from "bun:test";
import { pickProducerRoute } from "../src/producer-order";

type Row = { vesselId: string; endpoint: string; protocol?: string; origin?: string; discoveredVia?: string; libp2p_multiaddr?: string[]; egress_unreachable?: boolean };
type Route = { endpoint: string; resolvePath: string };
const EGRESS = "http://127.0.0.1:8401";
const local: Row = { vesselId: "development-vessel-local", endpoint: "http://127.0.0.1:8090", origin: "local" };
const peer = (id: string, extra: Partial<Row> = {}): Row => ({ vesselId: id, endpoint: "http://127.0.0.1:8401", protocol: "libp2p", discoveredVia: "peer", libp2p_multiaddr: [`/dns4/relay/tcp/1/p2p/R/p2p-circuit/p2p/${id}`], ...extra });
// routeFor as the walk's: a libp2p row goes through THIS node's egress with the peer as ?target=; a local row to itself.
const routeFor = (r: Row): Route => r.protocol === "libp2p" ? { endpoint: EGRESS, resolvePath: `/egress/resolve?target=${encodeURIComponent(r.libp2p_multiaddr![0]!)}` } : { endpoint: r.endpoint, resolvePath: "/v2/impulses/resolve" };
const keyOf = (r: Route) => `${r.endpoint}|${r.resolvePath}`;
const opts = (exclude?: Set<string>) => ({ endpointOf: (r: Route) => r.endpoint, keyOf, ...(exclude ? { exclude } : {}) });
const probeBy = (alive: Record<string, boolean>, seen: string[] = []) => async (ep: string) => { seen.push(ep); return alive[ep] ?? false; };

describe("(b) the pick probes the ROUTE: a libp2p route dials this node's egress, so it is probed", () => {
  it("[MUST-FAIL] a local row with one missed probe and a DEAD egress: the local row is returned (the all-dead fallback), never the dead egress", async () => {
    const got = await pickProducerRoute([local, peer("hub")], routeFor, probeBy({}), opts());
    expect(got?.endpoint).toBe(local.endpoint);
  });

  it("[MUST-FAIL] a row stamped egress_unreachable by discovery is a dead candidate", async () => {
    const got = await pickProducerRoute([peer("hub", { egress_unreachable: true }), local], routeFor, probeBy({ [local.endpoint]: true }), opts());
    expect(got?.endpoint).toBe(local.endpoint);
  });

  it("[CONTROL] the egress is live and the local row dead: the egress route is used", async () => {
    const got = await pickProducerRoute([local, peer("hub")], routeFor, probeBy({ [EGRESS]: true }), opts());
    expect(got?.endpoint).toBe(EGRESS);
  });

  it("[CONTROL] one probe per distinct endpoint per pick: two peers behind one egress probe it once", async () => {
    const seen: string[] = [];
    await pickProducerRoute([peer("hub"), peer("spoke")], routeFor, probeBy({}, seen), opts());
    expect(seen.filter((e) => e === EGRESS).length).toBe(1);
  });

  it("[HELD-OUT] a peer row routed to a NON-loopback host (its own endpoint) is accepted unprobed, as before", async () => {
    const seen: string[] = [];
    const remote: Row = { vesselId: "x@peer", endpoint: "http://10.8.0.5:8090", discoveredVia: "peer" };
    const got = await pickProducerRoute([remote], (r) => ({ endpoint: r.endpoint, resolvePath: "/v2/impulses/resolve" }), probeBy({}, seen), opts());
    expect(got?.endpoint).toBe("http://10.8.0.5:8090");
    expect(seen).toEqual([]);
  });

  it("[CONTROL] without endpointOf the old row rule stands (only a local loopback row is probed)", async () => {
    const seen: string[] = [];
    await pickProducerRoute([peer("hub")], routeFor, probeBy({}, seen));
    expect(seen).toEqual([]);
  });
});

describe("(c) the retry re-picks excluding the failed route; an auth refusal poisons the route, not the shape", () => {
  it("[MUST-FAIL] [a local row with a missed probe, a healthy egress whose peer refuses]: the re-pick after the refusal reaches the local row", async () => {
    const alive = { [EGRESS]: true };
    const first = await pickProducerRoute([local, peer("hub")], routeFor, probeBy(alive), opts());
    expect(first?.endpoint).toBe(EGRESS);
    const failed = new Set([keyOf(first!)]);
    const second = await pickProducerRoute([local, peer("hub")], routeFor, probeBy(alive), opts(failed));
    expect(second?.endpoint).toBe(local.endpoint);
  });

  it("[CONTROL] the only route failed: the re-pick finds nothing else (the walk retries the SAME route once only when transient)", async () => {
    const r = routeFor(peer("hub"));
    expect(await pickProducerRoute([peer("hub")], routeFor, probeBy({ [EGRESS]: true }), opts(new Set([keyOf(r)])))).toBeNull();
  });

  it("[HELD-OUT] poisoning one peer route leaves another peer behind the same egress selectable", async () => {
    const alive = { [EGRESS]: true };
    const got = await pickProducerRoute([peer("hub"), peer("spoke")], routeFor, probeBy(alive), opts(new Set([keyOf(routeFor(peer("hub")))])));
    expect(got?.resolvePath).toContain("spoke");
  });

});
