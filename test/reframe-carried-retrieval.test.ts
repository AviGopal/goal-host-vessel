// Acceptance fix 1 (live: node 1, dispatch 1e3cd499). The re-frame continued from a CARRIED
// satisfier:web_search (V8) that the writer consumed, reached, and was rejected: "answered WITHOUT
// retrieving anything though the walk planned [web_resource]". The judge's completion shapes named
// only the answer. Must-fail on the parent: the guard read completion shapes only. qa9: a retrieval
// counts only if it FED the deliverable (involvedSteps), not merely because it ran.
import { describe, expect, test } from "bun:test";
import * as walkPool from "../src/walk-pool";

type Edge = { inputShapes: string[]; inputImpulseIds: string[]; outputShapes: string[]; outputImpulseIds: string[] };
const RETRIEVAL = new Set(["http_fetch", "web_resource", "shellResult", "web_search", "webSearchResult", "fs_read"]);
const walkRetrieved = (walkPool as Record<string, unknown>)["walkRetrieved"] as ((c: string[], p: string[], r: ReadonlySet<string>) => boolean) | undefined;
const fed = (edges: Edge[], completion: string[]) =>
  [...new Set(walkPool.involvedSteps(edges, new Set(completion)).flatMap((i) => edges[i]!.outputShapes))];

// node 1's re-frame: [carried satisfier:web_search, satisfier:llm_completion (bound web_search), satisfier:memoryNote_write (bound llm)]
const N1: Edge[] = [
  { inputShapes: [], inputImpulseIds: [], outputShapes: ["web_search"], outputImpulseIds: ["ws"] },
  { inputShapes: ["web_search"], inputImpulseIds: ["ws"], outputShapes: ["llm_completion"], outputImpulseIds: ["llm"] },
  { inputShapes: ["llm_completion"], inputImpulseIds: ["llm"], outputShapes: ["memoryNote_write"], outputImpulseIds: ["mn"] },
];

describe("walkRetrieved", () => {
  test("must-fail on parent: node 1 — a carried web_search the writer consumed counts as retrieval", () => {
    expect(typeof walkRetrieved).toBe("function");
    expect(walkRetrieved!(["llm_completion", "memoryNote_write"], fed(N1, ["llm_completion", "memoryNote_write"]), RETRIEVAL)).toBe(true);
  });
  test("qa9: a retrieval that ran but fed nothing does not count", () => {
    const e: Edge[] = [
      { inputShapes: [], inputImpulseIds: [], outputShapes: ["web_resource"], outputImpulseIds: ["wr"] },
      { inputShapes: [], inputImpulseIds: [], outputShapes: ["llm_completion"], outputImpulseIds: ["llm"] },
    ];
    expect(walkRetrieved!(["llm_completion"], fed(e, ["llm_completion"]), RETRIEVAL)).toBe(false);
  });
  test("must-fail control kept: a re-frame whose chain fetched nothing (the 4.2 AU case) is not retrieval", () => {
    expect(walkRetrieved!(["llm_completion"], ["llm_completion"], RETRIEVAL)).toBe(false);
  });
});

describe("wiring (source)", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
  test("the re-frame guard reads what FED the re-frame's deliverable, carried steps included", () => {
    expect(src).toContain("const altRetrieved = walkRetrieved(altProduced, altWalkResult.fedDeliverableShapes ?? [], RETRIEVAL_EVIDENCE);");
    expect(src).toContain("fedDeliverableShapes: [...new Set(involvedSteps(chain.map((_, i) => stepEdges.get(i)), new Set(completionShapes ?? []), () => false, stepIsStub)");
  });
  test("carried steps enter the chain with their recorded edges at intake", () => {
    const i = src.indexOf("for (const c of carryForTarget(opts.carryFrom ?? [], target))");
    expect(src.slice(i, i + 2500)).toContain("recordStepEdge(_carriedIn, outShapes);");
  });
});
