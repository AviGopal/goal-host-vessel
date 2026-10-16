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
import { readFileSync } from "node:fs";
import { pickProducerRoute } from "../src/producer-order";
import { authRefusalCode } from "../src/auth-refusal";

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

  it("[MUST-FAIL] an auth refusal carried as CONTENT (200 + {error:\"unauthorized\"}) is classified as an auth refusal", () => {
    // Measured (dispatch c02fcc77): the enforcing hub's answer, which the walk pooled as a hollow llm_completion_dispatch.
    expect(authRefusalCode({ content: { error: "unauthorized", shape: "llm_completion_dispatch", reason: "absent", note: "this shape requires a caller credential identity validates" } })).toBe("unauthorized");
    expect(authRefusalCode({ error: { code: "INVALID_API_KEY" } })).toBe("INVALID_API_KEY");
    expect(authRefusalCode({ body: { failure_mode: "caller_credential_required" } })).toBe("caller_credential_required");
  });

  it("[CONTROL] real content, other errors, and prose that merely says 'unauthorized' are not auth refusals", () => {
    expect(authRefusalCode({ content: { text: "the user was unauthorized to see the report" } })).toBeNull();
    expect(authRefusalCode({ error: "pointer.decompose_gap_id is required" })).toBeNull();
    expect(authRefusalCode({ content: { ok: true, children: ["a"] } })).toBeNull();
    expect(authRefusalCode("unauthorized")).toBeNull();
  });

  it("[WIRING] rawResolve never pools an auth-refusal envelope: it notes a 401-equivalent failure and poisons the route", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const at = src.indexOf("const _authCode = authRefusalCode(parsed);");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 900);
    expect(block).toContain("noteRawResolveFailure(shape, `auth refusal (${_authCode}) from ${endpoint}`, 401);");
    expect(block).toContain("_failed.add(routeKey({ endpoint, resolvePath }));");
    expect(block).toContain("return null;");
    // the check runs before the body is accepted as content
    expect(at).toBeLessThan(src.indexOf("EXTERNAL-EVIDENCE / HTTP FAILURE ENVELOPE"));
  });

  it("[WIRING] the walk's satisfier retry re-picks with the walk's failed routes, poisons an auth refusal, and passes the route rule to both picks", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).toContain("const _authRefused = direct === null && (lastRawResolveStatus === 401 || lastRawResolveStatus === 403);");
    expect(src).toContain("const pickExclude = failedRoutesByShape.get(shape);");
    expect(src).toContain("const _repick = await endpointForShape(shape);");
    expect(src).toContain("poisoned for this walk (cross-authority evidence)");
    expect(src.match(/pickProducerRoute\([^)]*routePickOpts\(pickExclude\)\)/g)?.length).toBe(2);
    expect(src).toContain("lastRawResolveStatus = status;");
  });
});
