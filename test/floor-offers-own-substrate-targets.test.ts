// THE FLOOR OFFERS THE GOAL'S ADVERTISED TARGET SHAPES THIS SUBSTRATE SERVES, AND NOTHING ELSE NEW (CHANGE-29).
//
// User ruling (qa session, 2026-10-16T06:06:38Z), "Own-substrate, any non-forbidden (Recommended)": "Offer the
// goal's advertised target shapes, read or executable, but only when the producer is on our own substrate (reuse
// CHANGE-15's ordering; refuse foreign rows) and never FLOOR_FORBIDDEN_TOOLS (no shell). Also drop the dead
// source_code." The floor's offer was hand-written from day one (1cf0b96): a goal whose target was an advertised,
// readable shape reached a floor that could not call it.
//
//   [MUST-FAIL] an advertised non-write target (docs_align_tick) is a floor candidate; the floor builds it with the
//               own-substrate resolver and its loop calls it through that resolver.
//   [CONTROL]   target ["shellResult"] (and every FLOOR_FORBIDDEN_TOOLS alias) is never offered.
//   [CONTROL]   a target whose only producer is foreign is not own-substrate (not offered; a direct call is refused).
//   [CONTROL]   source_code is not offered; a hand tool discovery no longer advertises is dropped; an unknown
//               vocabulary keeps the hand list; NAMED_SHAPE_EXCLUDE is honoured; write shapes keep their own path.
//
// Source pins for index.ts (importing it reads the live dispatch store and arms timers).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const ft = (await import("../src/floor-tools")) as Record<string, any>;
const po = (await import("../src/producer-order")) as Record<string, any>;
const { NAMED_SHAPE_EXCLUDE } = await import("../src/goal-target-inference");
const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const KNOWN = new Set(["fs_read", "codeSearchResult", "fs_grep", "substrateGap", "docs_align_tick", "system_load_report", "shellResult", "fileContent", "memoryNote_write"]);
const OWN = new Set(["http://10.0.0.2:18100"]);

describe("the floor's offer follows discovery, own substrate only, never a shell", () => {
  it("[MUST-FAIL] an advertised non-write target is offered and called through the own-substrate resolver", () => {
    expect(typeof ft["floorTargetCandidates"]).toBe("function");
    expect(ft["floorTargetCandidates"](["docs_align_tick", "system_load_report"], KNOWN, NAMED_SHAPE_EXCLUDE)).toEqual(["docs_align_tick", "system_load_report"]);
    expect(SRC).toContain('const t = await ufBuildWriteTool(ts, "resolve", ufOwnProducerUrl);');
    expect(SRC).toContain("const loop = await runGroundedToolLoop(prompt, tools, writeShapes, floorOwnOnly);");
    expect(SRC).toContain("const res = await ufExecuteTool(nm, a, allowlist, ownOnly);");
    expect(SRC).toContain("const turl = ownOnly?.has(name) ? await ufOwnProducerUrl(name) : await ufResolveUrl(name);");
    expect(SRC).toMatch(/floor: TOOLS \[\$\{tools\.map/);
  });

  it("[CONTROL] no shell is ever offered", () => {
    expect(ft["floorTargetCandidates"](["shellResult"], KNOWN, NAMED_SHAPE_EXCLUDE)).toEqual([]);
    const all = new Set([...KNOWN, ...ft["FLOOR_FORBIDDEN_TOOLS"]]);
    expect(ft["floorTargetCandidates"]([...ft["FLOOR_FORBIDDEN_TOOLS"]], all, new Set())).toEqual([]);
  });

  it("[CONTROL] a foreign-only producer is not own-substrate; a local or own-peer row is", () => {
    const foreign = { endpoint: "http://203.0.113.9:18200", origin: "peer:http://203.0.113.9:18100", discoveredVia: "peer", peerEndpoint: "http://203.0.113.9:18100" };
    const ownPeer = { endpoint: "http://10.0.0.2:18200", origin: "peer:http://10.0.0.2:18100", discoveredVia: "peer", peerEndpoint: "http://10.0.0.2:18100" };
    const local = { endpoint: "http://127.0.0.1:8200", origin: "local" };
    expect(po["isOwnSubstrateRow"](foreign, OWN)).toBe(false);
    expect(po["isOwnSubstrateRow"](foreign, undefined)).toBe(false);
    expect(po["isOwnSubstrateRow"](ownPeer, OWN)).toBe(true);
    expect(po["isOwnSubstrateRow"](local, OWN)).toBe(true);
    expect(po["isOwnSubstrateRow"]({ ...ownPeer, protocol: "libp2p" }, OWN)).toBe(false);
    // the refusal at execution names the reason
    expect(SRC).toContain("no own-substrate resolver for shape (foreign producers refused)");
  });

  it("[CONTROL] source_code gone; unadvertised hand tools dropped; unknown vocabulary keeps the list; exclusions honoured", () => {
    expect(ft["UNIVERSAL_READ_TOOLS"].map((t: any) => t.name)).not.toContain("source_code");
    expect(ft["floorHandToolNames"](new Set(["fs_read", "codeSearchResult", "substrateGap"]))).toEqual(["fs_read", "codeSearchResult", "substrateGap"]);
    // Pin changed under the user ruling of 2026-10-26T19:05:13Z ("Shell on the floor now anyway"): the floor's hand list
    // is UNIVERSAL_FLOOR_TOOLS (the read tools plus web_search and bounded_shell).
    expect(ft["floorHandToolNames"](new Set())).toEqual(ft["UNIVERSAL_FLOOR_TOOLS"].map((t: any) => t.name));
    expect(ft["floorTargetCandidates"](["fileContent"], KNOWN, NAMED_SHAPE_EXCLUDE)).toEqual([]);
    expect(ft["floorTargetCandidates"](["memoryNote_write", "fs_read", "not_advertised"], KNOWN, NAMED_SHAPE_EXCLUDE)).toEqual([]);
  });
});
