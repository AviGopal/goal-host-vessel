// route-around.ts — the record a stalled walk emits (agentic-floor D P5 gate, a30a893c shape).
import { describe, expect, test } from "bun:test";
import { buildRouteAround, noteRouteTaken } from "./route-around";

describe("buildRouteAround", () => {
  const rec = buildRouteAround({
    goalHash: "a30a893c",
    target: ["web_search", "llm_completion", "obsidian:write_note"],
    produced: ["goal", "web_search", "llm_completion"],
    missing: ["obsidian:write_note"],
    satisfierFailures: new Map([["obsidian:write_note", "not registered: no vessel advertising obsidian:write_note"]]),
    pickFailures: new Map([["learned-composition-problem-detection-to-obsidian-write-note", "template unfetchable"]]),
    termination: "no producer or constructible payload for missing shapes [obsidian:write_note]",
    now: 1,
  });
  test("positive (D P5): missing_producer names the dead terminal and failed_producers carry the deterministic reasons", () => {
    expect(rec.kind).toBe("stall");
    expect(rec.missing_producer).toEqual(["obsidian:write_note"]);
    expect(rec.failed_producers).toEqual([
      { shape: "obsidian:write_note", producer: "satisfier:obsidian:write_note", reason: "not registered: no vessel advertising obsidian:write_note" },
      { shape: "", producer: "learned-composition-problem-detection-to-obsidian-write-note", reason: "template unfetchable" },
    ]);
    expect(rec.produced).toEqual(["web_search", "llm_completion"]);
    expect(rec.route_taken).toBe("stop");
  });
  test("the route the dispatch took is named on the same record, in order", () => {
    noteRouteTaken(rec, "reframe");
    noteRouteTaken(rec, "universal-tool-fallback");
    expect(rec.route_taken).toBe("universal-tool-fallback");
    expect(rec.routes_taken).toEqual(["reframe", "universal-tool-fallback"]);
  });
  test("an empty missing set is a no-target stall (trigger 3), a reused floor is floor_as_pathway", () => {
    const base = { goalHash: "g", target: [], produced: [], missing: [], satisfierFailures: new Map<string, string>(), pickFailures: new Map<string, string>(), termination: "t" };
    expect(buildRouteAround(base).kind).toBe("no_target");
    expect(buildRouteAround({ ...base, kind: "floor_as_pathway" }).kind).toBe("floor_as_pathway");
  });
  test("a walk that did not stall has no record, and noting a route on it writes nothing", () => {
    expect(() => noteRouteTaken(undefined, "reframe")).not.toThrow();
  });
});

describe("qa follow-ups: what goes on goalWalkState (an unauthenticated read) is scrubbed", () => {
  const route = (reason: string, secrets: string[] = []) => buildRouteAround({ goalHash: "g", target: ["x"], produced: [], missing: ["x"], satisfierFailures: new Map([["x", reason]]), pickFailures: new Map(), termination: `stall: ${reason}`, secrets, now: 1 });
  test("must-fail on parent: credential material in an upstream error body never reaches the record", () => {
    const held = "mb-HELDKEY0123456789abcdef-sig";
    const r = route(`HTTP 401 {"error":"bad key ${held}", "authorization":"ApiKey zz-secret-abcdefgh", tok eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl, ANTHROPIC_API_KEY=sk-ant-123456789}`, [held]);
    const all = JSON.stringify(r);
    for (const leak of [held, "zz-secret-abcdefgh", "eyJhbGciOi.eyJzdWIiOiJ4In0", "sk-ant-123456789"]) expect(all).not.toContain(leak);
    expect(r.failed_producers[0]!.reason).toContain("HTTP 401");   // the failure reason survives
    expect(r.termination).not.toContain(held);
  });
});
