// V4 (agentic-floor B2 + wiring of B1/B4), through the real index.ts exports and source.
//
// Must-fail control for B2 (track B S10, 9/178 stored composites): a mixed template+satisfier chain
// built POSITIONALLY names the template id `activity:⟨…⟩` as the next step's input shape. With the
// recorded step edges, no composite task input is a template id or a walk- pool id (27cc619's
// detector, extended), and the satisfier-only chain keeps the edges the ledger recorded.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
type Edge = { inputShapes: string[]; inputImpulseIds: string[]; outputShapes: string[]; outputImpulseIds: string[] };
let build: (chain: string[], execIds: string[], produced: string[], d: number, c: number, tags?: string[], pool?: Array<{ id: string; metadata?: { shape?: string } }>, sig?: string, edges?: Array<Edge | undefined>) => { tasks: Array<{ inputShapes?: string[]; inputImpulseIds?: string[]; outputShapes?: string[] }>; templateId: string };
beforeAll(async () => {
  globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  build = (await import("../src/index")).buildCompositeTraceFromChain as unknown as typeof build;
});
afterAll(() => { globalThis.fetch = realFetch; });

const TEMPLATE = "activity:⟨compose-auto-bridge-problem_detection-to-code_modification_proposal⟩";
const CHAIN = ["satisfier:code_read_lines", TEMPLATE, "satisfier:code_modification_proposal"];
const POOL = [
  { id: "walk-d1-code_read_lines-1", metadata: { shape: "code_read_lines" } },
  { id: "walk-d1-problem_detection-2", metadata: { shape: "problem_detection" } },
  { id: "walk-d1-code_modification_proposal-3", metadata: { shape: "code_modification_proposal" } },
];
const PRODUCED = ["code_read_lines", "problem_detection", "code_modification_proposal"];
const BAD_INPUT = /^activity:|⟨|^walk-/;

describe("buildCompositeTraceFromChain", () => {
  test("must-fail (positional fallback, today's 9/178): a template id becomes an input shape", () => {
    const t = build(CHAIN, ["e1", "e2", "e3"], PRODUCED, 0, 0, [], POOL, "g");
    expect(t.tasks.some((k) => (k.inputShapes ?? []).some((s) => BAD_INPUT.test(s)))).toBe(true);
  });
  test("with recorded edges: no input shape is a template id or a walk- id; the template step outputs its real shape", () => {
    const edges: Edge[] = [
      { inputShapes: [], inputImpulseIds: [], outputShapes: ["code_read_lines"], outputImpulseIds: ["walk-d1-code_read_lines-1"] },
      { inputShapes: ["code_read_lines"], inputImpulseIds: ["walk-d1-code_read_lines-1"], outputShapes: ["problem_detection"], outputImpulseIds: ["walk-d1-problem_detection-2"] },
      { inputShapes: ["problem_detection"], inputImpulseIds: ["walk-d1-problem_detection-2"], outputShapes: ["code_modification_proposal"], outputImpulseIds: ["walk-d1-code_modification_proposal-3"] },
    ];
    const t = build(CHAIN, ["e1", "e2", "e3"], PRODUCED, 0, 0, [], POOL, "g", edges);
    expect(t.tasks.every((k) => (k.inputShapes ?? []).every((s) => !BAD_INPUT.test(s)))).toBe(true);
    expect(t.tasks[1]!.outputShapes).toEqual(["problem_detection"]);
    expect(t.tasks[2]!.inputImpulseIds).toEqual(["walk-d1-problem_detection-2"]);
  });
  test("an unbound step declares no edge (a leading read, a goal-only writer)", () => {
    const t = build(["satisfier:web_search", "satisfier:llm_completion"], ["e1", "e2"], ["web_search", "llm_completion"], 0, 0, [], [], "g",
      [{ inputShapes: [], inputImpulseIds: [], outputShapes: ["web_search"], outputImpulseIds: ["w1"] }, { inputShapes: [], inputImpulseIds: [], outputShapes: ["llm_completion"], outputImpulseIds: ["w2"] }]);
    expect(t.tasks[1]!.inputShapes).toEqual([]);
  });
  test("the template id (the extractor's upsert key) is unchanged by edges", () => {
    expect(build(CHAIN, ["e1"], PRODUCED, 0, 0, [], POOL, "g").templateId).toBe(build(CHAIN, ["e1"], PRODUCED, 0, 0, [], POOL, "g", []).templateId);
  });
});

describe("walk wiring (source)", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
  test("B4: the satisfier declares consumption from what its resolve bound, not every chain-produced shape", () => {
    expect(src).toContain("boundConsumption(stepBound, chainProduced, satisfiableNow, terminalShapes)");
    expect(src).not.toContain('[...chainProduced].filter((s) => s !== "goal" && s !== satisfiableNow && !terminalShapes.has(s))');
    // direct-bind: when the shell value is written, the findings block was NOT bound
    expect(src).toContain('stepBound = new Set<string>(["shellResult"]);');
  });
  test("B1: pool ids are per-dispatch and step outputs name their real producer", () => {
    expect(src).not.toContain("id: `walk-${shape}-${++impulseSeq}`");
    expect(src).toContain("{ producedBy: `satisfier:${satisfiableNow}` }");
    expect(src).toContain("{ producedBy: pick.id, producerExecutionId: trace.id, consumedIds: _pickConsumedIds }");
    expect(src).toMatch(/producerExecutionId: m\.producerExecutionId \?\? null/);
  });
  test("B2: the walk's composite is built from the recorded step edges", () => {
    expect(src).toContain('goalHashOf(goal), chain.map((_, i) => stepEdges.get(i)))');
  });
});
