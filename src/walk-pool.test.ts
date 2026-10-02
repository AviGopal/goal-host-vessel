// walk-pool.ts — the binding / provenance / edge rules (agentic-floor B4, B1, B2), pure.
import { describe, expect, test } from "bun:test";
import * as wp from "./walk-pool";
import { findingsDigest, boundConsumption, poolImpulseId, poolIdsOf, declaredBound, stepEdgeOf } from "./walk-pool";

const imp = (id: string, shape: string, content: unknown) => ({ id, metadata: { shape }, content });
const POOL = [
  imp("p1", "goal", { goal: "What is happening today?" }),
  imp("p2", "web_search", { results: [{ title: "t", url: "https://x" }] }),
  imp("p3", "webSearchResult", { results: [{ title: "t", url: "https://x" }] }),
];
const CHAIN_PRODUCED = new Set(["web_search", "webSearchResult"]);

describe("B4 — consumption is declared only when bound", () => {
  test("must-fail control (10-01 08:57–08:59Z rows): a re-frame (no terminal shapes) binds nothing, so llm_completion declares NO web_search edge", () => {
    const f = findingsDigest(POOL, new Set());
    expect(f).toEqual({ text: "", shapes: [] });
    expect(boundConsumption(f.shapes, CHAIN_PRODUCED, "llm_completion", new Set())).toEqual([]);
  });
  test("positive control (cea3f4a4 #1, bound): with a terminal, the search findings are in the prompt and the edge is declared", () => {
    const terms = new Set(["memoryNote_write"]);
    const f = findingsDigest(POOL, terms);
    expect(f.text).toContain("## web_search");
    expect(f.shapes).toEqual(["web_search", "webSearchResult"]);
    expect(boundConsumption(f.shapes, CHAIN_PRODUCED, "llm_completion", terms)).toEqual(["web_search", "webSearchResult"]);
  });
  test("a bound seed (not produced by a chain step) and the step's own shape never count", () => {
    expect(boundConsumption(["goal", "seed_note", "llm_completion", "web_search"], CHAIN_PRODUCED, "llm_completion", new Set())).toEqual(["web_search"]);
  });
});

describe("B1 — pool ids are unique per dispatch", () => {
  test("two walks of one dispatch no longer mint the same id for the same shape", () => {
    const a = poolImpulseId("5bef2e86-aaaa-bbbb", "web_search");
    const b = poolImpulseId("5bef2e86-aaaa-bbbb", "web_search");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^walk-[a-z0-9]{6}-[a-z0-9]{7}-web_search-\d+$/);
  });
  test("ids resolve by shape, first-wins (the pool's rule)", () => {
    expect(poolIdsOf([...POOL, imp("p4", "web_search", "later")], ["web_search"])).toEqual(["p2"]);
  });
});

test("B2 — a template step bound exactly its declared inputs that the pool held", () => {
  expect(declaredBound(["goal", "problem_detection", "absent"], ["goal", "problem_detection"])).toEqual(["problem_detection"]);
});

describe("B2 — the mint-gate coupling, controlled", () => {
  test("a template step that recovered only a provenance stub contributes NO output id (cannot ground a composite)", () => {
    const pool = [imp("s1", "problem_detection", { producedBy: "activity:x", executionId: "exec_1" })];
    expect(stepEdgeOf(pool, [], ["problem_detection"]).outputImpulseIds).toEqual([]);
  });
  test("a template step that produced real content does (it is a producing step, like a satisfier)", () => {
    const pool = [imp("s2", "problem_detection", { problems: [{ line: 3 }] })];
    expect(stepEdgeOf(pool, ["code_read_lines"], ["problem_detection"]).outputImpulseIds).toEqual(["s2"]);
  });
});

describe("qa follow-ups", () => {
  test("dispatch ids sharing a prefix (dispatch-drop-*) no longer collapse to one id prefix", () => {
    const a = poolImpulseId("dispatch-drop-aaaa", "x").split("-").slice(0, 3).join("-");
    const b = poolImpulseId("dispatch-drop-bbbb", "x").split("-").slice(0, 3).join("-");
    expect(a).not.toBe(b);
  });
  test("must-fail on parent: two output-bearing tasks with no edge between them are not a mintable recipe", () => {
    const hasRealEdge = (wp as Record<string, unknown>)["hasRealEdge"] as ((t: unknown[]) => boolean) | undefined;
    expect(typeof hasRealEdge).toBe("function");
    expect(hasRealEdge!([{ inputImpulseIds: [], outputImpulseIds: ["a"] }, { inputImpulseIds: [], outputImpulseIds: ["b"] }])).toBe(false);
    expect(hasRealEdge!([{ inputImpulseIds: [], outputImpulseIds: ["a"] }, { inputImpulseIds: ["a"], outputImpulseIds: ["b"] }])).toBe(true);
    expect(hasRealEdge!([{ inputImpulseIds: ["b"], outputImpulseIds: ["a"] }, { inputImpulseIds: [], outputImpulseIds: ["b"] }])).toBe(false); // edges point backward only
  });
  test("wiring: the composite's mint/tag decision requires a real edge (source)", () => {
    const src = require("node:fs").readFileSync(`${import.meta.dir}/index.ts`, "utf8") as string;
    expect(src).toMatch(/\.length >= 2 && hasRealEdge\(composite\.tasks(, carriedSteps)?\)\);/);
  });
});
