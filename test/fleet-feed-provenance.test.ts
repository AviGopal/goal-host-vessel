// The fleet activity feed reports only what its store reads returned.
//
// fleetActivityFeed is served to any caller and rendered by the human panels as the group's
// open work. Every gap in it must trace back to a real read: an entry written into the source
// is not a gap anyone detected, and it also hides the panel's own fallback read (which only
// runs when the feed's gap list is empty). Nor may the feed point readers at hosts the
// substrate does not run, or carry the substrate's repository names out in a URL.
//
// A feed any caller can read must also only READ. It declares its read set below; a resolve
// of any other shape (feature_compose above all, which can land a commit) is not a read.
//
// index.ts cannot be imported without its module-load bootstrap, so the scenarios run in a
// child process with every fetch stubbed (the same seam as transport-hop-credential.test.ts).
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

interface Gap { substrate: string; id: string; category: string; status: string; summary: string; [k: string]: unknown }
interface Feed { gaps: Gap[]; [k: string]: unknown }
interface Call { url: string; method: string; pointerType: string | null; shape: string | null }
let probe: { empty: Feed; rows: Feed; calls: Call[] };

beforeAll(async () => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "fleet-feed-provenance-probe.ts")], {
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT: "0",
      GOAL_HOST_VESSEL_API_KEY: "mb-test-fleet-feed-provenance-0123456789", FED_SUBSTRATE_ID: "this-substrate",
      FED_TRANSPORT_EGRESS: "http://127.0.0.1:18401",
      DISCOVERY_VESSEL_ENDPOINT: "http://127.0.0.1:18100", PRODUCER_DISCOVERY_ENDPOINT: "http://127.0.0.1:18080",
      ACTIVITY_API_ENDPOINT: "http://127.0.0.1:18080", LLM_VESSEL_ENDPOINT: "http://127.0.0.1:18220",
      DEVELOPMENT_VESSEL_ENDPOINT: "http://127.0.0.1:18090",
      GOAL_HOST_DISABLE_SUBSCRIBERS: "1", GOAL_HOST_WS_SUBSCRIBER: "0",
    },
    stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const line = out.split("\n").find((l) => l.startsWith("PROBE "));
  if (!line) throw new Error("probe printed no result");
  probe = JSON.parse(line.slice(6)) as typeof probe;
}, 60_000);

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const urlsIn = (feed: Feed): string[] => JSON.stringify(feed).match(/https?:\/\/[^"\s\\]+/g) ?? [];

describe("fleetActivityFeed gap provenance", () => {
  test("with every store read empty, the feed carries no gaps", () => {
    expect(probe.empty.gaps).toEqual([]);
  });

  test("a row a compose resolver would offer never enters the feed", () => {
    expect(probe.rows.gaps.find((g) => g.id === "fc-probe-row-1")).toBeUndefined();
    expect(probe.rows.gaps.some((g) => g.category === "feature_compose")).toBe(false);
  });

  test("the only gaps are the ones the gap store returned", () => {
    expect(probe.rows.gaps.map((g) => g.id)).toEqual(["gap-probe-real-1"]);
  });
});

describe("fleetActivityFeed URLs", () => {
  test("every URL the feed emits names a local host", () => {
    for (const feed of [probe.empty, probe.rows]) {
      for (const u of urlsIn(feed)) expect(LOCAL_HOSTS.has(new URL(u).hostname)).toBe(true);
    }
  });

  test("no URL the feed emits carries an owned repository name", () => {
    for (const u of urlsIn(probe.rows)) {
      expect(u).not.toContain("probe-owned-repo-alpha");
      expect(u).not.toContain("probe-owned-repo-beta");
    }
  });
});

// The feed's declared reads: the dispatch roll-up (capability lookup + peer activeDispatches),
// the gap store, the boredom snapshots, and the rhythm due-state (capability lookup + producer).
const READ_TYPES = new Set(["vesselCapability", "activeDispatches", "substrateGap", "poolImpulse", "rhythm_conductor_tick", "rhythm_reality_sync"]);
const CAPABILITY_SHAPES = new Set(["activeDispatches", "rhythm_conductor_tick", "rhythm_reality_sync"]);

describe("fleetActivityFeed only reads", () => {
  test("the probe exercised every declared read", () => {
    const seen = new Set(probe.calls.map((c) => c.pointerType));
    for (const t of READ_TYPES) expect(seen.has(t)).toBe(true);
  });

  test("no request resolves feature_compose", () => {
    expect(probe.calls.filter((c) => c.pointerType === "feature_compose")).toEqual([]);
  });

  test("every request names a shape in the declared read set", () => {
    const outside = probe.calls.filter((c) => c.pointerType !== null && !READ_TYPES.has(c.pointerType));
    expect(outside).toEqual([]);
    const capOutside = probe.calls.filter((c) => c.pointerType === "vesselCapability" && !CAPABILITY_SHAPES.has(c.shape ?? ""));
    expect(capOutside).toEqual([]);
  });

  test("every request without a shape is a GET", () => {
    expect(probe.calls.filter((c) => c.pointerType === null && c.method !== "GET")).toEqual([]);
  });
});

describe("control: a stored gap passes through unchanged", () => {
  test("the gap store's open gap is reported as stored", () => {
    const g = probe.rows.gaps.find((x) => x.id === "gap-probe-real-1");
    expect(g).toEqual({ substrate: "local", id: "gap-probe-real-1", category: "probe", status: "open", summary: "a real stored gap" });
  });
});
