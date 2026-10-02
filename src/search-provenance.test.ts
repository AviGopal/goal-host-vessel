// Pins the walk's half of the web_resource search-provenance gate (user ruling 10-02: "allow any
// https URL that a web_search in the same walk returned"). The walk sends a REFERENCE to the search
// impulse, chosen only among impulses a search satisfier produced; development-vessel re-reads that
// impulse through goalWalkState {impulseId} and verifies the URL itself.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { forgetLivePool, isSatisfierSearchImpulse, livePool, rememberLivePool, searchProvenanceFor, searchResultUrls, walkStateImpulse, type PoolImpulseLike } from "./walk-pool";

const URL_A = "https://www.example.org/report-2026.html";
const searchContent = { query: "q", results: [{ title: "A", url: URL_A, snippet: "s" }, { title: "B", url: "https://b.example.net/x", snippet: "t" }], provider: "openrouter-web-plugin" };

const satisfierSearch: PoolImpulseLike = { id: "walk-x-d-webSearchResult-1", metadata: { shape: "webSearchResult", producedBy: "satisfier:webSearchResult", producerExecutionId: "walk-satisfier-1-1" }, content: searchContent };
// A poolImpulse_write injection: any authenticated caller can queue one, and it lands with the walk's
// default producer and no producing execution.
const injectedSearch: PoolImpulseLike = { id: "walk-x-d-webSearchResult-2", metadata: { shape: "webSearchResult", producedBy: "goal-host-walk" }, content: { results: [{ title: "evil", url: "https://evil.example/x", snippet: "" }] } };

describe("searchProvenanceFor — which search impulse the walk cites", () => {
  it("names the satisfier-produced search impulse whose results contain the url", () => {
    expect(searchProvenanceFor([satisfierSearch], URL_A)).toBe(satisfierSearch.id);
  });
  it("reads a JSON-string body the same way", () => {
    expect(searchProvenanceFor([{ ...satisfierSearch, content: JSON.stringify(searchContent) }], URL_A)).toBe(satisfierSearch.id);
    expect(searchResultUrls(JSON.stringify(searchContent))).toContain(URL_A);
  });
  it("never cites an injected (poolImpulse_write) search result", () => {
    expect(searchProvenanceFor([injectedSearch], "https://evil.example/x")).toBeNull();
  });
  it("cites nothing for a url no search returned", () => {
    expect(searchProvenanceFor([satisfierSearch], "https://not-returned.example/")).toBeNull();
  });
});

describe("goalWalkState {impulseId} — one live pool impulse in full", () => {
  it("serves the registered pool's impulse with its producer, by reference (later pushes visible)", () => {
    const pool: PoolImpulseLike[] = [];
    rememberLivePool("dispatch-prov-1", pool);
    pool.push(satisfierSearch);
    const got = walkStateImpulse(livePool("dispatch-prov-1"), satisfierSearch.id);
    expect(got?.producedBy).toBe("satisfier:webSearchResult");
    expect(got?.producerExecutionId).toBe("walk-satisfier-1-1");
    expect(searchResultUrls(got?.content)).toContain(URL_A);
  });
  it("answers null for an unknown dispatch or impulse", () => {
    expect(walkStateImpulse(livePool("no-such-dispatch"), satisfierSearch.id)).toBeNull();
    expect(walkStateImpulse(livePool("dispatch-prov-1"), "nope")).toBeNull();
  });
});

describe("index.ts wiring", () => {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  it("registers the walk pool and serves goalWalkState {impulseId} from it", () => {
    expect(src).toContain("rememberLivePool(opts.variables.dispatch_id, poolImpulses);");
    expect(src).toContain("walkStateImpulse(livePool(wid), _impId)");
  });
  it("rawResolve drops a synthesized provenance and attaches only the walk's own reference", () => {
    const at = src.indexOf("if (PROVENANCE_FETCH_SHAPES.has(shape)) {");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 700);
    expect(block).toContain("delete pointer.provenance;");
    expect(block).toContain("searchProvenanceFor(poolImpulses, pointer.url)");
    expect(block).toContain("pointer.provenance = { dispatch_id: _wid, impulse_id: _pid };");
  });
});

describe("qa10: the impulse read serves only search results, and only while the walk runs", () => {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  it("goalWalkState {impulseId} serves an impulse only when isSatisfierSearchImpulse holds, else 404", () => {
    const at = src.indexOf("if (_impId) {");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 900);
    expect(block).toContain("isSatisfierSearchImpulse(_imp)");
    expect(block).toContain("{ status: impulse ? 200 : 404 }");
  });
  it("a non-search impulse (a shell result, an injected search) is never served in full", () => {
    // The predicate the handler gates on, applied to what a probe would ask for.
    const pool: PoolImpulseLike[] = [satisfierSearch, injectedSearch, { id: "walk-x-d-shellResult-3", metadata: { shape: "shellResult", producedBy: "satisfier:shellResult", producerExecutionId: "e" }, content: { stdout: "secret" } }];
    const served = pool.filter((i) => isSatisfierSearchImpulse(i)).map((i) => i.id);
    expect(served).toEqual([satisfierSearch.id]);
  });
  it("the walk unregisters its pool in a finally, on every exit path", () => {
    const at = src.indexOf("async function runGoalAsPoolWalk(goal: string, opts: Parameters<typeof runGoalAsPoolWalkBody>[1])");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 300);
    expect(block).toMatch(/try \{\s*return await runGoalAsPoolWalkBody\(goal, opts\);\s*\} finally \{\s*forgetLivePool\(opts\.variables\.dispatch_id\);/);
    pool_forget_check();
  });
});

function pool_forget_check(): void {
  rememberLivePool("dispatch-forget", [satisfierSearch]);
  expect(livePool("dispatch-forget")).toBeDefined();
  forgetLivePool("dispatch-forget");
  expect(livePool("dispatch-forget")).toBeUndefined();
}
