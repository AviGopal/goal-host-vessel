// The caller's credential reaches the federation transport as a HEADER on the local hop,
// never inside the pointer/body goal-host builds (and traces).
//
// Once the transport's ingress admits callers by their own credential (it no longer lends
// the node's key), a resolve that crosses with no credential is refused for every
// trust_group shape. Two goal-host paths sent none: the llm_completion cascade in
// llm-router (routeOverRanked) and the activeDispatches roll-up in the fleet activity feed.
// The transport takes the Authorization header of the local request and moves it into the
// wire pointer itself, so the body must stay credential-free.
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { transportHopHeaders } from "../src/llm-router";

const FAKE_KEY = "mb-test-transport-hop-credential-0123456789";
const EGRESS = "http://127.0.0.1:18401";
interface Call { url: string; authorization: string | null; body: string }
interface Probe { routedOk: boolean; llm: Call[]; roll: Call[]; peerDispatches: unknown }
let probe: Probe;

beforeAll(async () => {
  // A clean environment: the modules read key and endpoints at load (see the fixture).
  const p = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "transport-hop-probe.ts")], {
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      GOAL_HOST_VESSEL_API_KEY: FAKE_KEY, FED_TRANSPORT_EGRESS: EGRESS, FED_SUBSTRATE_ID: "this-substrate",
      DISCOVERY_VESSEL_ENDPOINT: "http://127.0.0.1:18100", PRODUCER_DISCOVERY_ENDPOINT: "http://127.0.0.1:18080",
      ACTIVITY_API_ENDPOINT: "http://127.0.0.1:18080", LLM_VESSEL_ENDPOINT: "http://127.0.0.1:18220",
      GOAL_HOST_DISABLE_SUBSCRIBERS: "1", GOAL_HOST_WS_SUBSCRIBER: "0",
    },
    stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const line = out.split("\n").find((l) => l.startsWith("PROBE "));
  if (!line) throw new Error("probe printed no result");
  probe = JSON.parse(line.slice(6)) as Probe;
}, 60_000);

const isEgress = (u: string) => u.startsWith(EGRESS + "/");
function expectNoCredentialIn(body: string): void {
  expect(body).not.toContain(FAKE_KEY);
  expect(body).not.toContain("_auth");
  expect(body.toLowerCase()).not.toContain("authorization");
}

describe("transportHopHeaders", () => {
  test("attaches the caller's key only to the local transport", () => {
    const E = "http://127.0.0.1:8401";
    expect(transportHopHeaders(E + "/egress/resolve?target=x", E, "k1").Authorization).toBe("ApiKey k1");
    expect(transportHopHeaders(E + "/v2/impulses/resolve", E, "k1").Authorization).toBe("ApiKey k1");
    // a discovered endpoint elsewhere is never handed this node's key
    expect(transportHopHeaders("http://10.0.0.9:8220/resolve", E, "k1").Authorization).toBeUndefined();
    expect(transportHopHeaders("http://127.0.0.1:8220/resolve", E, "k1").Authorization).toBeUndefined();
    expect(transportHopHeaders("not a url", E, "k1").Authorization).toBeUndefined();
    expect(transportHopHeaders(E + "/egress/resolve", E, "").Authorization).toBeUndefined();
  });
});

describe("llm-router cascade over the federation transport", () => {
  test("every egress hop carries the caller's key as a header; no body carries it", () => {
    expect(probe.routedOk).toBe(false);
    const egress = probe.llm.filter((c) => isEgress(c.url));
    // the winner plus the cascade over the other federated arm
    expect(egress.length).toBeGreaterThanOrEqual(2);
    for (const c of egress) {
      expect(c.authorization).toBe(`ApiKey ${FAKE_KEY}`);
      expectNoCredentialIn(c.body);
      expect(JSON.parse(c.body).type).toBe("llm_completion");
    }
    // nothing else this path called was handed the key in a body either
    for (const c of probe.llm) expectNoCredentialIn(c.body);
  });
});

describe("fleet activity feed: activeDispatches roll-up over the federation transport", () => {
  test("the egress hop carries the caller's key as a header; the pointer does not", () => {
    const egress = probe.roll.filter((c) => isEgress(c.url));
    expect(egress.length).toBe(1);
    const c = egress[0]!;
    expect(c.authorization).toBe(`ApiKey ${FAKE_KEY}`);
    expectNoCredentialIn(c.body);
    expect(JSON.parse(c.body).impulse.pointer).toEqual({ type: "activeDispatches", _fedTargetVessel: "goal-host-vessel" });
    expect(probe.peerDispatches).toEqual([{ dispatchId: "d-remote" }]);
  });
});
