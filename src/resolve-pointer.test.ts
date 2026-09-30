import { describe, expect, it } from "bun:test";
import { buildResolvePointer } from "./resolve-pointer";

// The shape a walk resolves is its own decision: synthesized args must never change it (2026-09-30: a synthesized
// type "http_fetch" turned every web_search step into a 404 and the goal into filler).
describe("buildResolvePointer keeps the walk's shape", () => {
  it("a synthesized type cannot override the shape (the http_fetch regression)", () => {
    const p = buildResolvePointer("web_search", {}, { type: "http_fetch", query: "top news headlines today" });
    expect(p.type).toBe("web_search");
    expect(p.query).toBe("top news headlines today");
  });

  it("synthesized args still override pool defaults", () => {
    const p = buildResolvePointer("web_search", { query: "pool default", limit: 5 }, { query: "synthesized" });
    expect(p).toEqual({ query: "synthesized", limit: 5, type: "web_search" });
  });

  it("a type in the pool defaults cannot override the shape either", () => {
    expect(buildResolvePointer("llm_completion", { type: "stale" }, {}).type).toBe("llm_completion");
  });

  it("absent synthesized args leave just the pool and the shape", () => {
    expect(buildResolvePointer("shellResult", { cwd: "/w" }, undefined)).toEqual({ cwd: "/w", type: "shellResult" });
  });
});

describe("buildResolvePointer at the proxy-resolver sites (variables < config, shape last)", () => {
  it("config wins over variables and neither can re-route the shape", () => {
    const p = buildResolvePointer("gh_pr_create", { target_branch: "feature", type: "x" }, { target_branch: "main", type: "y" });
    expect(p).toEqual({ target_branch: "main", type: "gh_pr_create" });
  });
});
