// Walk locality, ordered shape cache: the startup registry cache (shapeEndpointMap)
// used to keep ONE endpoint per shape, last writer wins, and the walk's
// endpointForShape returned it before ever consulting discovery — so a shape
// served locally and over the overlay went to whichever row the registry listed
// last. The cache now keeps every producer row per shape, ordered local-first by
// orderProducers, and the walk picks from that list with the same probe rule as
// the discovery path (pickProducerRoute).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildShapeProducerCache, pickProducerRoute } from "../src/producer-order";

const S = "llm_completion_dispatch";
const localRow = (endpoint = "http://127.0.0.1:8230", extra: Record<string, unknown> = {}) => ({
  vesselId: `local@${endpoint}`, endpoint, shapes: [S], resolve_endpoint: "/resolve", origin: "local", ...extra,
});
const overlayRow = (extra: Record<string, unknown> = {}) => ({
  vesselId: "llm-vessel@hub", endpoint: "http://10.8.0.5:18230", shapes: [S], protocol: "libp2p", origin: "overlay",
  libp2p_multiaddr: ["/ip4/10.8.0.5/tcp/4001/p2p/QmHub"], ...extra,
});
const ids = (rows: ReadonlyArray<{ vesselId?: string }> | undefined) => (rows ?? []).map((r) => r.vesselId);
const byEndpoint = (r: { endpoint?: string }) => r.endpoint ?? "";

describe("buildShapeProducerCache — every producer per shape, local first", () => {
  test("registry [overlay, local] for one shape: the local row heads the list", () => {
    const cache = buildShapeProducerCache([overlayRow(), localRow()]);
    expect(ids(cache.get(S))).toEqual(["local@http://127.0.0.1:8230", "llm-vessel@hub"]);
  });

  test("registry [local, overlay] for one shape: the local row heads the list (no last-writer-wins)", () => {
    const cache = buildShapeProducerCache([localRow(), overlayRow()]);
    expect(ids(cache.get(S))).toEqual(["local@http://127.0.0.1:8230", "llm-vessel@hub"]);
  });

  test("rows keep origin and protocol", () => {
    const rows = buildShapeProducerCache([overlayRow(), localRow()]).get(S)!;
    expect(rows[1]!.origin).toBe("overlay");
    expect(rows[1]!.protocol).toBe("libp2p");
  });

  test("control: two local rows keep registry order; a row with several shapes lands under each", () => {
    const a = localRow("http://127.0.0.1:1", { shapes: [S, "other"] });
    const b = localRow("http://localhost:2");
    const cache = buildShapeProducerCache([a, overlayRow(), b]);
    expect(ids(cache.get(S))).toEqual([a.vesselId, b.vesselId, "llm-vessel@hub"]);
    expect(ids(cache.get("other"))).toEqual([a.vesselId]);
  });

  test("control: rows with no endpoint, and non-string shapes, are not cached", () => {
    const cache = buildShapeProducerCache([
      { vesselId: "noep", shapes: [S] },
      { vesselId: "blank", endpoint: "", shapes: [S] },
      localRow("http://127.0.0.1:3", { shapes: [S, 7, "", null] }),
    ]);
    expect(ids(cache.get(S))).toEqual(["local@http://127.0.0.1:3"]);
    expect([...cache.keys()]).toEqual([S]);
  });

  test("control: an overlay-only shape is still cached", () => {
    expect(ids(buildShapeProducerCache([overlayRow()]).get(S))).toEqual(["llm-vessel@hub"]);
  });
});

describe("pickProducerRoute — the walk's pick over an ordered list", () => {
  test("cached local + overlay, local probe passes: the local row is used", async () => {
    const rows = buildShapeProducerCache([overlayRow(), localRow()]).get(S)!;
    expect(await pickProducerRoute(rows, byEndpoint, async () => true)).toBe("http://127.0.0.1:8230");
  });

  test("cached local + overlay, local probe FAILS: falls through to the overlay row", async () => {
    const rows = buildShapeProducerCache([localRow(), overlayRow()]).get(S)!;
    const probed: string[] = [];
    const got = await pickProducerRoute(rows, byEndpoint, async (ep) => { probed.push(ep); return false; });
    expect(got).toBe("http://10.8.0.5:18230");
    expect(probed).toEqual(["http://127.0.0.1:8230"]);
  });

  test("a probe that throws counts as a failed probe", async () => {
    const rows = buildShapeProducerCache([localRow(), overlayRow()]).get(S)!;
    expect(await pickProducerRoute(rows, byEndpoint, async () => { throw new Error("ECONNREFUSED"); })).toBe("http://10.8.0.5:18230");
  });

  test("control: overlay-only resolves, unprobed", async () => {
    let probes = 0;
    const got = await pickProducerRoute([overlayRow()], byEndpoint, async () => { probes++; return false; });
    expect(got).toBe("http://10.8.0.5:18230");
    expect(probes).toBe(0);
  });

  test("control: a remote row whose endpoint is the peer's loopback is accepted unprobed", async () => {
    let probes = 0;
    const got = await pickProducerRoute([overlayRow({ endpoint: "http://127.0.0.1:18230" })], byEndpoint, async () => { probes++; return false; });
    expect(got).toBe("http://127.0.0.1:18230");
    expect(probes).toBe(0);
  });

  test("control: every local probe fails and nothing else exists: the first row is returned (never below status quo)", async () => {
    const rows = [localRow("http://127.0.0.1:1"), localRow("http://127.0.0.1:2")];
    expect(await pickProducerRoute(rows, byEndpoint, async () => false)).toBe("http://127.0.0.1:1");
  });

  test("control: a non-loopback local row is accepted unprobed; no endpoint is skipped; empty is null", async () => {
    let probes = 0;
    const got = await pickProducerRoute([{ vesselId: "x" }, localRow("http://development-vessel:8090")], byEndpoint, async () => { probes++; return false; });
    expect(got).toBe("http://development-vessel:8090");
    expect(probes).toBe(0);
    expect(await pickProducerRoute([], byEndpoint, async () => true)).toBeNull();
  });
});

describe("wiring: the registry fill and the walk use the ordered cache", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
  const walkStart = src.indexOf("const endpointForShape = async (shape: string)");
  const walkEnd = src.indexOf("let lastRawResolveReason", walkStart);
  const walk = walkStart >= 0 && walkEnd > walkStart ? src.slice(walkStart, walkEnd) : "";
  const fillStart = src.indexOf('JSON.stringify({ pointer: { type: "vesselRegistry" } })');
  const fillEnd = src.indexOf("discoveredProxyShapes = shapes;", fillStart);
  const fill = fillStart >= 0 && fillEnd > fillStart ? src.slice(fillStart, fillEnd) : "";

  test("both regions are found", () => {
    expect(walk.length).toBeGreaterThan(0);
    expect(fill.length).toBeGreaterThan(0);
  });
  test("the registry fill builds the cache with buildShapeProducerCache (which orders via orderProducers)", () => {
    expect(fill).toMatch(/\bbuildShapeProducerCache\(/);
    expect(fill).not.toMatch(/shapeEndpointMap\.set\(s, \{ endpoint: ep, resolvePath: rp \}\)/);
  });
  test("buildShapeProducerCache orders through orderProducers", () => {
    const mod = readFileSync(join(import.meta.dir, "..", "src", "producer-order.ts"), "utf8");
    const i = mod.indexOf("export function buildShapeProducerCache");
    const body = i >= 0 ? mod.slice(i, mod.indexOf("\n}\n", i)) : "";
    expect(body).toMatch(/\borderProducers\(/);
  });
  test("the walk picks from the cached rows with pickProducerRoute", () => {
    expect(walk).toMatch(/pickProducerRoute\(\s*mapped\.rows/);
  });
  test("the walk's discovery path picks with pickProducerRoute too", () => {
    expect(walk).toMatch(/pickProducerRoute\(\s*ordered/);
  });
  test("the cached path is still skipped under target_vessel_id and PREFER_LIBP2P_ROUTE", () => {
    const guard = walk.slice(0, walk.indexOf("pickProducerRoute(") + 1);
    expect(guard).toContain("target_vessel_id");
    expect(guard).toContain('process.env.PREFER_LIBP2P_ROUTE !== "1"');
  });
});
