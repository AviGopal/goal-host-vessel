import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildResolvePointer, toolPointer } from "./resolve-pointer";

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

// A model-requested tool call resolves the tool it was routed by: ufExecuteTool's args cannot change the type.
describe("toolPointer keeps the tool's own shape", () => {
  it("a model-supplied type cannot re-route the tool", () => {
    const p = toolPointer("webSearchResult", { query: "headlines today", type: "http_fetch" }, {});
    expect(p.type).toBe("webSearchResult");
    expect(p.query).toBe("headlines today");
    expect(JSON.stringify(p)).not.toContain("http_fetch");
  });

  it("precedence is caller defaults < args < extras, with type last", () => {
    const p = toolPointer("llm_completion_dispatch", { task_type: "model", prompt: "p", type: "x" }, { execution_id: "d1" }, { caller: "c", task_type: "default" });
    expect(p).toEqual({ caller: "c", task_type: "model", prompt: "p", execution_id: "d1", type: "llm_completion_dispatch" });
  });

  it("extras cannot re-route the tool either", () => {
    expect(toolPointer("shellResult", { command: "ls" }, { type: "y" }).type).toBe("shellResult");
  });

  it("ufExecuteTool builds its pointer with toolPointer", () => {
    const index = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    const start = index.indexOf("async function ufExecuteTool(");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = index.indexOf("\nasync function ", start + 1);
    const body = index.slice(start, next < 0 ? undefined : next);
    expect(body).toContain("impulse: { pointer: toolPointer(name, args, ");
    expect(body).not.toContain("...args");
    expect(body).not.toMatch(/type: name\b/);
  });
});
