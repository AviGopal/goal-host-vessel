// Child process for transport-hop-credential.test.ts. llm-router and index read their key
// and endpoints at module load, and bun shares one module cache across a test run, so the
// scenarios run here, in a process whose environment the test sets, and report what each
// fetch carried as one JSON line on stdout.
const EGRESS = process.env["FED_TRANSPORT_EGRESS"]!;
const isEgress = (u: string) => u.startsWith(EGRESS + "/");
interface Call { url: string; authorization: string | null; body: string }
const calls: Call[] = [];
let respond: (url: string, body: string) => Response = () => Response.json({});
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const body = typeof init?.body === "string" ? init.body : "";
  calls.push({ url, authorization: new Headers(init?.headers ?? {}).get("authorization"), body });
  return respond(url, body);
}) as typeof fetch;

// 1. llm-router: two federated llm_completion arms, both failing, so the Thompson winner
//    falls through to routeOverRanked's cascade over the other.
respond = (url, body) => {
  if (isEgress(url)) return Response.json({ error: "unauthorized" }, { status: 502 });
  if (url.endsWith("/resolve") && body.includes("vesselCapability") && body.includes("llm_completion")) {
    return Response.json({
      content: {
        vessels: [
          { vesselId: "llm-resolver-a@hub-x", protocol: "libp2p", libp2p_multiaddr: ["/ip4/10.0.0.1/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmA"] },
          { vesselId: "llm-resolver-b@hub-x", protocol: "libp2p", libp2p_multiaddr: ["/ip4/10.0.0.1/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmB"] },
        ],
      },
    });
  }
  return Response.json({});
};
const { routedComplete } = await import("../../src/llm-router");
const routed = await routedComplete("dispatch-transport-hop", "goal_target_inference", { prompt: "hello" });
const llm = calls.splice(0);

// 2. index.ts fleet activity feed: one peer goal-host advertises activeDispatches.
respond = (url, body) => {
  if (isEgress(url)) return Response.json({ content: { body: { dispatches: [{ dispatchId: "d-remote" }] } } });
  if (url.endsWith("/resolve") && body.includes("activeDispatches")) {
    return Response.json({ content: { vessels: [{ vesselId: "goal-host-vessel@peer-sub", libp2p_multiaddr: ["/ip4/10.0.0.2/tcp/4001/p2p/QmPeer"] }] } });
  }
  return Response.json({});
};
const { resolveFleetActivityFeed } = await import("../../src/index");
const feed = (await resolveFleetActivityFeed()) as unknown as { members: Array<{ substrate: string; dispatches: unknown[] }> };
const roll = calls.splice(0);

process.stdout.write("\nPROBE " + JSON.stringify({
  routedOk: routed.ok, llm, roll,
  peerDispatches: feed.members.find((m) => m.substrate === "peer-sub")?.dispatches ?? null,
}) + "\n");
process.exit(0);
