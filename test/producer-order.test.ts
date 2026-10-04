// Walk locality: the walk's endpointForShape must try a producer on this node
// before one reached over the overlay or a peer. The previous comparator put
// NON-loopback rows first and returned the first one unprobed, so a shape with a
// local producer and an overlay facade went over the hub relay.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLoopbackHost, orderProducers } from "../src/producer-order";

const local = (endpoint: string, extra: Record<string, unknown> = {}) => ({ id: endpoint, endpoint, ...extra });
const overlay = (id: string) => ({
  id,
  endpoint: "http://10.8.0.5:18090",
  protocol: "libp2p",
  origin: "overlay",
  libp2p_multiaddr: ["/ip4/10.8.0.5/tcp/4001/p2p/QmPeer"],
});

describe("orderProducers — local producers first", () => {
  test("a local row and an overlay row for one shape: the local one wins", () => {
    const rows = [overlay("ov"), local("http://127.0.0.1:8090", { origin: "local" })];
    expect(orderProducers(rows).map((r) => r.id)).toEqual(["http://127.0.0.1:8090", "ov"]);
  });

  test("a row stamped origin:local wins even on a non-loopback host", () => {
    const rows = [overlay("ov"), local("http://development-vessel:8090", { origin: "local" })];
    expect(orderProducers(rows)[0]!.id).toBe("http://development-vessel:8090");
  });

  test("a localhost row with no origin counts as local", () => {
    const rows = [overlay("ov"), local("http://localhost:8090")];
    expect(orderProducers(rows)[0]!.id).toBe("http://localhost:8090");
  });

  test("[::1] and 127.0.0.2 count as local", () => {
    expect(orderProducers([overlay("ov"), local("http://[::1]:8090")])[0]!.id).toBe("http://[::1]:8090");
    expect(orderProducers([overlay("ov"), local("http://127.0.0.2:8090")])[0]!.id).toBe("http://127.0.0.2:8090");
  });

  test("overlay/peer rows come before unclassified non-loopback rows", () => {
    const rows = [local("http://10.0.0.9:8090"), { id: "peer", endpoint: "http://192.168.1.4:18090", origin: "peer:http://192.168.1.4:18100" }];
    expect(orderProducers(rows).map((r) => r.id)).toEqual(["peer", "http://10.0.0.9:8090"]);
  });

  // ── controls ──
  test("control: only an overlay row is still used", () => {
    expect(orderProducers([overlay("ov")]).map((r) => r.id)).toEqual(["ov"]);
  });

  test("control: two local rows keep discovery order", () => {
    const rows = [local("http://127.0.0.1:9002"), local("http://localhost:9001"), overlay("ov"), local("http://[::1]:9003")];
    expect(orderProducers(rows).map((r) => r.id)).toEqual([
      "http://127.0.0.1:9002",
      "http://localhost:9001",
      "http://[::1]:9003",
      "ov",
    ]);
  });

  test("control: a peer row carrying the PEER's loopback endpoint is not local", () => {
    const rows = [
      { id: "peer-lo", endpoint: "http://127.0.0.1:8090", origin: "peer:http://hub:18100" },
      { id: "fac-lo", endpoint: "http://127.0.0.1:8091", protocol: "libp2p" },
      { id: "dv-lo", endpoint: "http://127.0.0.1:8092", discoveredVia: "peer" },
      local("http://127.0.0.1:8093"),
    ];
    expect(orderProducers(rows)[0]!.id).toBe("http://127.0.0.1:8093");
  });

  test("control: a row with no or an unparseable endpoint does not throw and sorts last", () => {
    const rows = [{ id: "none" }, { id: "bad", endpoint: "not a url" }, local("http://127.0.0.1:1")];
    expect(orderProducers(rows).map((r) => r.id)).toEqual(["http://127.0.0.1:1", "none", "bad"]);
  });

  test("control: the input array is not reordered in place", () => {
    const rows = [overlay("ov"), local("http://127.0.0.1:1")];
    orderProducers(rows);
    expect(rows.map((r) => r.id)).toEqual(["ov", "http://127.0.0.1:1"]);
  });
});

describe("isLoopbackHost", () => {
  test("loopback forms", () => {
    for (const h of ["localhost", "LOCALHOST", "::1", "[::1]", "127.0.0.1", "127.0.0.2", "127.255.255.254"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });
  test("non-loopback forms", () => {
    for (const h of ["10.0.0.1", "128.0.0.1", "localhost.example.com", "notlocalhost", "::2", "development-vessel", ""]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("wiring: the walk's endpointForShape orders through orderProducers", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
  const start = src.indexOf("const endpointForShape = async (shape: string)");
  const end = src.indexOf("let lastRawResolveReason", start);
  const body = start >= 0 && end > start ? src.slice(start, end) : "";

  test("the inner endpointForShape is found", () => {
    expect(body.length).toBeGreaterThan(0);
  });
  test("index.ts imports orderProducers from producer-order", () => {
    expect(src).toMatch(/import\s*\{[^}]*\borderProducers\b[^}]*\}\s*from\s*["']\.\/producer-order(?:\.ts)?["']/);
  });
  test("endpointForShape calls orderProducers", () => {
    expect(body).toMatch(/\borderProducers\(/);
  });
  test("the inverted comparator is gone", () => {
    expect(body).not.toContain("'a' is loopback, 'b' is not, 'a' comes after 'b'");
  });
});
