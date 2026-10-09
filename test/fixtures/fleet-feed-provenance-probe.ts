// Child process for fleet-feed-provenance.test.ts. index.ts reads its endpoints at module
// load and bun shares one module cache across a test run, so the scenarios run here, in a
// process whose environment the test sets, with every fetch stubbed and recorded. Each
// scenario's feed, and every request the feed made, is reported as one JSON line on stdout.
interface Call { url: string; method: string; pointerType: string | null; shape: string | null }
type Respond = (url: string, pointer: Record<string, unknown>) => Response;
const calls: Call[] = [];
let respond: Respond = () => Response.json({});

// The pointer a request names, wherever the caller put it: { pointer }, { impulse: { pointer } },
// or a bare { impulse: { type } }.
function pointerOf(body: string): Record<string, unknown> {
  try {
    const j = JSON.parse(body) as Record<string, any>;
    return (j?.pointer ?? j?.impulse?.pointer ?? j?.impulse ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const body = typeof init?.body === "string" ? init.body : "";
  const pointer = pointerOf(body);
  calls.push({
    url,
    method: init?.method ?? "GET",
    pointerType: typeof pointer.type === "string" ? pointer.type : null,
    shape: typeof pointer.shape === "string" ? pointer.shape : null,
  });
  return respond(url, pointer);
}) as typeof fetch;

const { resolveFleetActivityFeed } = await import("../../src/index");

// 1. Every read answers empty.
respond = () => Response.json({});
const empty = await resolveFleetActivityFeed();

// 2. Every read answers with something real: a peer advertising activeDispatches, a rhythm
//    producer, an open gap in the gap store, a boredom snapshot. A resolver that would answer
//    feature_compose with a row whose producer owns repositories is also on offer, so a feed
//    that asked for it would show it.
respond = (url, p) => {
  if (p.type === "vesselCapability" && p.shape === "activeDispatches") {
    return Response.json({ content: { vessels: [{ vesselId: "goal-host-vessel@peer-sub", libp2p_multiaddr: ["/ip4/10.0.0.2/tcp/4001/p2p/QmPeer"] }] } });
  }
  if (p.type === "vesselCapability" && typeof p.shape === "string" && p.shape.startsWith("rhythm_")) {
    return Response.json({ content: { vessels: [{ endpoint: "http://127.0.0.1:18130" }] } });
  }
  if (p.type === "activeDispatches") return Response.json({ content: { body: { dispatches: [{ dispatchId: "d-remote" }] } } });
  if (p.type === "substrateGap") {
    return Response.json({ body: { gaps: [{ id: "gap-probe-real-1", category: "probe", status: "open", summary: "a real stored gap" }] } });
  }
  if (p.type === "poolImpulse") return Response.json({ body: [{ id: "snap-1" }] });
  if (p.type === "rhythm_conductor_tick" || p.type === "rhythm_reality_sync") return Response.json({ due: false });
  if (p.type === "feature_compose") {
    return Response.json({ content: { rows: [{ id: "fc-probe-row-1", summary: "a compose row", status: "open", producer_id: "probe-owner-vessel" }] } });
  }
  if (p.type === "vesselRegistry") {
    return Response.json({ content: { vessels: [{ vesselId: "probe-owner-vessel@local", repositories: ["probe-owned-repo-alpha", "probe-owned-repo-beta"] }] } });
  }
  return Response.json({});
};
const rows = await resolveFleetActivityFeed();

process.stdout.write("\nPROBE " + JSON.stringify({ empty, rows, calls }) + "\n");
process.exit(0);
