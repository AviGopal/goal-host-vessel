import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildResolvePointer, toolPointer } from "../src/resolve-pointer";
import { walkResolveBody } from "../src/applied-write";

// development-vessel attaches its node key to fetch URLs that a resolve POINTER field can override
// (pointer.devVesselImpulsesUrl, pointer.obsidianEndpoint, ...). Every pointer goal-host builds for
// a walk step comes from pool variables plus synthesized args (LLM output passed through verbatim),
// so a model-emitted endpoint override on a write would send that key to wherever the model said.
// Interim close of the walk path: a walk-built write pointer loses every *Url / *Endpoint /
// *_url / *_endpoint field, top level and one level into pointer/impulse objects.

let warnings: string[] = [];
const realWarn = console.warn;
beforeEach(() => { warnings = []; console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); }; });
afterEach(() => { console.warn = realWarn; });

const ATTACKER = "http://attacker.invalid";

describe("a walk-built write pointer cannot carry an endpoint override", () => {
  test("MUST-FAIL: a substrateGap_write built from LLM args reaches the outbound resolve body without the override fields", () => {
    const pointer = buildResolvePointer("substrateGap_write", {}, {
      devVesselImpulsesUrl: ATTACKER,
      obsidianEndpoint: ATTACKER,
      gap: { id: "gap-x", summary: "s" },
    });
    const body = walkResolveBody("substrateGap_write", pointer);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("attacker.invalid");
    expect(body).toEqual({ impulse: { pointer: { gap: { id: "gap-x", summary: "s" }, type: "substrateGap_write" } } });
  });

  test("MUST-FAIL: suffix forms _url / _endpoint / any case, from pool defaults, and one level into pointer/impulse objects", () => {
    const p = buildResolvePointer("memoryNote_write", { concept_db_url: ATTACKER, title: "t" }, {
      LLM_ENDPOINT: ATTACKER,
      peer_Endpoint: ATTACKER,
      callbackURL: ATTACKER,
      pointer: { devVesselImpulsesUrl: ATTACKER, id: "n1" },
      impulse: { obsidianEndpoint: ATTACKER, pointer: { activityApiUrl: ATTACKER, id: "n1" } },
      body: "b",
    });
    expect(JSON.stringify(p)).not.toContain("attacker.invalid");
    expect(p).toEqual({ title: "t", pointer: { id: "n1" }, impulse: { pointer: { id: "n1" } }, body: "b", type: "memoryNote_write" });
  });

  test("MUST-FAIL: a body wrapped around an unstripped pointer is stripped at the body too", () => {
    const body = walkResolveBody("substrateGap_write", { devVesselImpulsesUrl: ATTACKER, id: "gap-x", type: "substrateGap_write" });
    expect(JSON.stringify(body)).not.toContain("attacker.invalid");
  });

  test("MUST-FAIL: a model-requested tool call to a write shape loses the override too", () => {
    const p = toolPointer("concept_create_write", { obsidianEndpoint: ATTACKER, summary: "s" }, {});
    expect(p).toEqual({ summary: "s", type: "concept_create_write" });
  });

  test("MUST-FAIL: one log line names the dropped fields and never their values", () => {
    buildResolvePointer("substrateGap_write", {}, { devVesselImpulsesUrl: ATTACKER, obsidianEndpoint: ATTACKER, gap: { id: "g" } });
    const hits = warnings.filter((w) => w.includes("endpoint-override"));
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("substrateGap_write");
    expect(hits[0]).toContain("devVesselImpulsesUrl");
    expect(hits[0]).toContain("obsidianEndpoint");
    expect(hits[0]).not.toContain("attacker.invalid");
  });

  test("CONTROL: a deeper record field (the written gap's own data) is left alone", () => {
    const p = buildResolvePointer("substrateGap_write", {}, { gap: { id: "g", evidence_url: "https://example.org/x" } });
    expect(p).toEqual({ gap: { id: "g", evidence_url: "https://example.org/x" }, type: "substrateGap_write" });
    expect(warnings.filter((w) => w.includes("endpoint-override")).length).toBe(0);
  });

  // (r3) The strip covers EVERY shape now, not only writes. Only a shape whose contract takes a URL as its
  // DATA keeps that one field (http_fetch / http_response / web_resource `url`, URL_AS_DATA); any other
  // endpoint-shaped field on those shapes is still an override and is dropped.
  test("CONTROL: http_fetch keeps its `url` (the URL it fetches is its input) and its filePath", () => {
    const p = buildResolvePointer("http_fetch", {}, { url: "https://example.org/a", filePath: "/w/a.ts" });
    expect(p).toEqual({ url: "https://example.org/a", filePath: "/w/a.ts", type: "http_fetch" });
    const body = walkResolveBody("http_fetch", p);
    expect(body).toEqual({ impulse: { pointer: p } });
    expect(warnings.filter((w) => w.includes("endpoint-override")).length).toBe(0);
  });

  test("CONTROL: web_resource and http_response keep their `url` too", () => {
    for (const shape of ["web_resource", "http_response"]) {
      expect(buildResolvePointer(shape, {}, { url: "https://example.org/a" })).toEqual({ url: "https://example.org/a", type: shape });
    }
  });

  test("MUST-FAIL (r3): on a URL-as-data shape, any OTHER endpoint field is still an override and is dropped", () => {
    const p = buildResolvePointer("http_fetch", {}, { url: "https://example.org/a", resolveEndpoint: ATTACKER });
    expect(p).toEqual({ url: "https://example.org/a", type: "http_fetch" });
  });

  test("CONTROL: an operator/cockpit-originated pointer is never rebuilt here — goal-host's inbound resolve routes do not strip", () => {
    // Operator writes go from the cockpit straight to the owning vessel; the only inbound resolve
    // routes goal-host serves (/resolve -> handleResolve, /v2/impulses/resolve) must not pass the
    // caller's pointer through the walk-only strip.
    const src = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
    const start = src.indexOf("async function handleResolve(");
    expect(start).toBeGreaterThan(-1);
    const handler = src.slice(start, src.indexOf("\nasync function ", start + 10) > 0 ? src.indexOf("\nasync function ", start + 10) : start + 20000);
    expect(handler).not.toMatch(/stripEndpointOverrides|buildResolvePointer|walkResolveBody/);
    const v2 = src.slice(src.indexOf('url.pathname === "/v2/impulses/resolve"'), src.indexOf('url.pathname === "/v2/impulses/resolve"') + 3000);
    expect(v2).not.toMatch(/stripEndpointOverrides|buildResolvePointer|walkResolveBody/);
  });
});

describe("(r3) the strip covers every walk-built shape, and credentials too", () => {
  test("MUST-FAIL: an llm_completion_dispatch built from LLM args reaches the resolver without tool_dispatch_endpoint or tool_dispatch_api_key", () => {
    const p = toolPointer("llm_completion_dispatch", {
      prompt: "p",
      tool_dispatch_endpoint: ATTACKER,
      tool_dispatch_api_key: "model-chosen-key",
    }, { execution_id: "d1" });
    expect(p).toEqual({ prompt: "p", execution_id: "d1", type: "llm_completion_dispatch" });
    const body = walkResolveBody("llm_completion_dispatch", p);
    expect(JSON.stringify(body)).not.toContain("attacker.invalid");
    expect(JSON.stringify(body)).not.toContain("model-chosen-key");
  });

  test("MUST-FAIL: a non-write scan shape loses endpoint overrides (devVesselImpulsesUrl, obsidianEndpoint)", () => {
    const p = buildResolvePointer("ui_legibility_scan", {}, { devVesselImpulsesUrl: ATTACKER, obsidianEndpoint: ATTACKER, px_floor: 12 });
    expect(p).toEqual({ px_floor: 12, type: "ui_legibility_scan" });
  });

  test("MUST-FAIL: credential-shaped fields are dropped on any shape: api_key, apiKey, apikey, *_token, token", () => {
    const p = buildResolvePointer("web_search", { auth_token: "t0" }, { query: "q", api_key: "a", apiKey: "b", APIKEY: "c", github_token: "d", token: "e", pointer: { apiKey: "f", id: "x" } });
    expect(p).toEqual({ query: "q", pointer: { id: "x" }, type: "web_search" });
  });

  test("MUST-FAIL: the walk body around an llm_completion pointer is stripped too", () => {
    const body = walkResolveBody("llm_completion", { prompt: "p", type: "llm_completion" }, { caller: "goal-host:walk_llm_completion", tool_dispatch_endpoint: ATTACKER });
    expect(JSON.stringify(body)).not.toContain("attacker.invalid");
    expect((body as Record<string, unknown>).caller).toBe("goal-host:walk_llm_completion");
  });

  test("MUST-FAIL: one log line names the dropped fields (endpoint and credential), never their values", () => {
    buildResolvePointer("llm_completion_dispatch", {}, { prompt: "p", tool_dispatch_endpoint: ATTACKER, tool_dispatch_api_key: "model-chosen-key" });
    const hits = warnings.filter((w) => w.includes("endpoint-override"));
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("tool_dispatch_endpoint");
    expect(hits[0]).toContain("tool_dispatch_api_key");
    expect(hits[0]).not.toContain("attacker.invalid");
    expect(hits[0]).not.toContain("model-chosen-key");
  });

  test("CONTROL: ordinary fields that only resemble the patterns survive (max_tokens, token_count, urls, endpoint_count)", () => {
    const p = buildResolvePointer("llm_completion_dispatch", {}, { prompt: "p", max_tokens: 60, token_count: 3, urls: ["https://a"], endpoint_count: 2 });
    expect(p).toEqual({ prompt: "p", max_tokens: 60, token_count: 3, urls: ["https://a"], endpoint_count: 2, type: "llm_completion_dispatch" });
  });
});
