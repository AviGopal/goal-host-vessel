// V7 (output-shapes step 2): the llm_completion writer binds the pool's evidence when no terminal is
// present. Must-fail on the parent layer: with no terminal shapes (every re-frame; every a30a893c walk
// once V1 removes obsidian:write_note) the writer's prompt is goal-only, so it cannot consume the
// web_search impulse and B4 honestly declares no edge — the slice's "grounded answer" criterion fails.
import { describe, expect, test } from "bun:test";
import * as walkPool from "../src/walk-pool";

const imp = (id: string, shape: string, content: unknown) => ({ id, metadata: { shape }, content });
const CHAIN = new Set(["web_search", "activity_template", "error", "problem_detection"]);
const POOL = [
  imp("p1", "goal", { goal: "What is happening today?" }),
  imp("p0", "operator", "human-surface"),
  imp("p0b", "obsidian_vessel_endpoint", "http://127.0.0.1:8300"),
  imp("p0c", "substrateGap", { id: "unrelated-standing-gap" }),
  imp("p2", "activity_template", { catalogue: "t".repeat(500) }),
  imp("p3", "error", { error: "API key missing" }),
  imp("p4", "web_search", { results: [{ title: "Iran war live", url: "https://www.aljazeera.com/news/liveblog/2026/10/1/iran-war-live" }] }),
  imp("p5", "problem_detection", { producedBy: "activity:x", executionId: "exec_1" }),
];
const writerFindings = (walkPool as Record<string, unknown>)["writerFindings"] as
  | ((pool: unknown[], terms: ReadonlySet<string>, writer: string, chainProduced?: ReadonlySet<string>) => { text: string; shapes: string[] })
  | undefined;

describe("writerFindings", () => {
  test("must-fail on parent: with NO terminal, the writer binds the search evidence (and only evidence)", () => {
    expect(typeof writerFindings).toBe("function");
    const f = writerFindings!(POOL, new Set(), "llm_completion", CHAIN);
    expect(f.shapes).toEqual(["web_search"]);
    expect(f.text).toContain("aljazeera.com/news/liveblog/2026/10/1/iran-war-live");
    expect(f.text).not.toContain("API key missing");
    expect(f.text).not.toContain("tttt");
    expect(f.text).not.toContain("exec_1");
  });
  test("must-fail (qa): seeds handed to the dispatch are context, not findings — only chain-produced shapes bind", () => {
    const f = writerFindings!(POOL, new Set(), "llm_completion", CHAIN);
    for (const seed of ["human-surface", "127.0.0.1:8300", "unrelated-standing-gap"]) expect(f.text).not.toContain(seed);
  });
  test("…and so B4 declares the web_search → llm_completion edge from what was bound", () => {
    const f = writerFindings!(POOL, new Set(), "llm_completion", CHAIN);
    expect(walkPool.boundConsumption(f.shapes, new Set(["web_search"]), "llm_completion", new Set())).toEqual(["web_search"]);
  });
  test("with a terminal, the binding is exactly the terminal write's (unchanged)", () => {
    const terms = new Set(["memoryNote_write"]);
    expect(writerFindings!(POOL, terms, "llm_completion")).toEqual(walkPool.findingsDigest(POOL, terms));
  });
  test("a pool with no evidence binds nothing (the goal-only prompt stays goal-only)", () => {
    expect(writerFindings!([POOL[0], POOL[1], POOL[5]], new Set(), "llm_completion", CHAIN)).toEqual({ text: "", shapes: [] });
  });
});

describe("wiring (source)", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
  test("the llm_completion default prompt binds through the writer path, chain-produced only", () => {
    expect(src).toContain("const _poolFindings = boundFindingsFromIntermediates(shape);");
    expect(src).toContain("writerFindings(poolImpulses, terminalShapes, writerShape, chainProduced)");
  });
  test("must-fail (qa): the no-terminal writer gets a neutral answer frame, not the gap-clustering frame", () => {
    const i = src.indexOf("pointer.prompt = (_poolFindings && _poolFindings.trim().length > 0 && terminalShapes.size === 0)");
    expect(i).toBeGreaterThan(0);
    const writerArm = src.slice(i, src.indexOf("\n        : (_poolFindings", i));
    expect(writerArm).toContain("${WRITER_EVIDENCE_FRAME}");
    expect(writerArm).not.toMatch(/clustered classes|member gap ids|invariant/);
    expect(walkPool.WRITER_EVIDENCE_FRAME).not.toMatch(/class|gap|invariant/i);
  });
  test("the 7bbd7e8 clustering wording is unchanged on the terminal-bound path it was written for", () => {
    expect(src).toContain("(the clustered classes, each with member gap ids and a testable invariant), fully written out.");
  });
});
