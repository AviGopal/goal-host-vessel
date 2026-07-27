import { describe, it, expect } from "bun:test";
import { inferGoalTargetShapes, inferGoalTargetDecision, goalHashOf } from "../src/goal-target-inference";

const KNOWN = ["problem_detection", "code_quality", "source_code", "obsidian:write_note", "concept"];

// Build a fake LLM fetch that returns `target_shapes` as a JSON block (mirroring
// the llm_completion resolver body), and counts invocations.
function fakeLLM(targetShapes: unknown, body: "content" | "text" = "content") {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    const json = JSON.stringify({ target_shapes: targetShapes });
    return {
      ok: true,
      json: async () => ({ body: { [body]: `Here you go:\n${json}\nthanks` } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe("inferGoalTargetShapes", () => {
  it("returns only shapes that are in knownShapes (filters hallucinations)", async () => {
    const { fetchImpl } = fakeLLM(["problem_detection", "totally_made_up_shape", "code_quality"]);
    const out = await inferGoalTargetShapes("find code-quality risks", KNOWN, {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(out).toEqual(["problem_detection", "code_quality"]);
    expect(out).not.toContain("totally_made_up_shape");
  });

  it("drops ALL shapes when none are known", async () => {
    const { fetchImpl } = fakeLLM(["made_up_a", "made_up_b"]);
    const out = await inferGoalTargetShapes("do something", KNOWN, {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(out).toEqual([]);
  });

  it("caps at 3 shapes and dedupes", async () => {
    const { fetchImpl } = fakeLLM([
      "problem_detection",
      "problem_detection",
      "code_quality",
      "source_code",
      "concept",
    ]);
    const out = await inferGoalTargetShapes("broad goal", KNOWN, {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(out.length).toBe(3);
    expect(new Set(out).size).toBe(out.length);
  });

  it("returns [] when LLM endpoint is unset", async () => {
    const out = await inferGoalTargetShapes("a goal", KNOWN, { llmEndpoint: undefined });
    expect(out).toEqual([]);
  });

  it("returns [] when knownShapes is empty", async () => {
    const { fetchImpl } = fakeLLM(["problem_detection"]);
    const out = await inferGoalTargetShapes("a goal", [], {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(out).toEqual([]);
  });

  it("returns [] on LLM HTTP failure", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch;
    const out = await inferGoalTargetShapes("a goal", KNOWN, {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(out).toEqual([]);
  });

  it("returns [] when the response has no parseable JSON block", async () => {
    const fetchImpl = (async () =>
      ({ ok: true, json: async () => ({ body: { content: "no json here at all" } }) } as unknown as Response)) as unknown as typeof fetch;
    const out = await inferGoalTargetShapes("a goal", KNOWN, {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(out).toEqual([]);
  });

  it("returns [] on thrown fetch (LLM down)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const out = await inferGoalTargetShapes("a goal", KNOWN, {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(out).toEqual([]);
  });

  it("caches by goal_hash — a second call with the same goal does NOT re-hit the LLM", async () => {
    const cache = new Map<string, string[]>();
    const { fetchImpl, calls } = fakeLLM(["problem_detection"]);
    const goal = "find code-quality risks in discovery-vessel";
    const first = await inferGoalTargetShapes(goal, KNOWN, {
      llmEndpoint: "http://llm.test",
      fetchImpl,
      cache,
    });
    const second = await inferGoalTargetShapes(goal, KNOWN, {
      llmEndpoint: "http://llm.test",
      fetchImpl,
      cache,
    });
    expect(first).toEqual(["problem_detection"]);
    expect(second).toEqual(first);
    expect(calls()).toBe(1); // only the first call hit the LLM
  });

  it("a DIFFERENT goal misses the cache and hits the LLM again", async () => {
    const cache = new Map<string, string[]>();
    const { fetchImpl, calls } = fakeLLM(["code_quality"]);
    await inferGoalTargetShapes("goal one", KNOWN, { llmEndpoint: "http://llm.test", fetchImpl, cache });
    await inferGoalTargetShapes("goal two", KNOWN, { llmEndpoint: "http://llm.test", fetchImpl, cache });
    expect(calls()).toBe(2);
  });

  it("reads the alternate body.text shape too", async () => {
    const { fetchImpl } = fakeLLM(["source_code"], "text");
    const out = await inferGoalTargetShapes("read a file", KNOWN, {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(out).toEqual(["source_code"]);
  });
});

// EXTRACT-FROM-SOURCE route (2026-07-27). "Read FILE and report the value of field X"
// must route to the compute (shellResult) that EXTRACTS the value, not green on the raw
// read. The route is DETERMINISTIC (returns before the LLM call), so a throwing fetch
// proves no LLM was consulted when it fires.
describe("inferGoalTargetDecision — extract-from-source route", () => {
  const KX = ["shellResult", "fileContent", "problem_detection", "llm_completion_dispatch"];
  const throwLLM = (async () => { throw new Error("LLM must NOT be called on the deterministic extract route"); }) as unknown as typeof fetch;

  it("routes 'report the value of package.json name field' to shellResult without hitting the LLM", async () => {
    const out = await inferGoalTargetDecision(
      'Read the file repos/goal-host-vessel/package.json and report the value of its "name" field.',
      KX,
      { llmEndpoint: "http://llm.test", fetchImpl: throwLLM },
    );
    expect(out.shapes).toEqual(["shellResult"]);
  });

  it("routes 'how many dependencies in package.json' to shellResult", async () => {
    const out = await inferGoalTargetDecision(
      "Read repos/activity-api/package.json and report how many entries are under its dependencies.",
      KX,
      { llmEndpoint: "http://llm.test", fetchImpl: throwLLM },
    );
    expect(out.shapes).toEqual(["shellResult"]);
  });

  it("does NOT route a summarize-the-file ask (falls through to the LLM path)", async () => {
    const { fetchImpl, calls } = fakeLLM(["llm_completion_dispatch"]);
    const out = await inferGoalTargetDecision(
      "Summarize what the file repos/goal-host-vessel/CLAUDE.md is about in two sentences.",
      KX,
      { llmEndpoint: "http://llm.test", fetchImpl },
    );
    expect(out.shapes).not.toEqual(["shellResult"]);
    expect(calls()).toBeGreaterThan(0);
  });

  it("does NOT hijack a code-quality analysis ask over a source file", async () => {
    const { fetchImpl } = fakeLLM(["problem_detection"]);
    const out = await inferGoalTargetDecision(
      "Report the code quality problems of repos/goal-host-vessel/src/index.ts",
      KX,
      { llmEndpoint: "http://llm.test", fetchImpl },
    );
    expect(out.shapes).not.toEqual(["shellResult"]);
  });

  it("does NOT route when there is no file operand", async () => {
    const { fetchImpl } = fakeLLM(["shellResult"]);
    const out = await inferGoalTargetDecision(
      "Report the value of the learning rate we are currently using.",
      KX,
      { llmEndpoint: "http://llm.test", fetchImpl },
    );
    // may or may not be shellResult via the LLM, but the deterministic route must not fire:
    // proven by the LLM being reachable (no throw). Assert it did not early-return a fabricated 0.6.
    expect(out.confidence).not.toBe(0.6);
  });
});

describe("goalHashOf", () => {
  it("is deterministic and not time-based", () => {
    const a = goalHashOf("the same goal");
    const b = goalHashOf("the same goal");
    expect(a).toBe(b);
  });

  it("differs for different goals", () => {
    expect(goalHashOf("goal A")).not.toBe(goalHashOf("goal B"));
  });
});

describe("inferGoalTargetDecision — registry/inventory count route", () => {
  const KR = ["shellResult", "fileContent", "source_code", "problem_detection"];
  const throwLLM = (async () => { throw new Error("LLM must NOT be called on the deterministic registry route"); }) as unknown as typeof fetch;
  it("routes 'how many vessels registered in discovery' to shellResult without the LLM", async () => {
    const out = await inferGoalTargetDecision("How many vessels are currently registered in the discovery registry? Report the number.", KR, { llmEndpoint: "http://llm.test", fetchImpl: throwLLM });
    expect(out.shapes).toEqual(["shellResult"]);
  });
  it("does NOT hijack an analysis-over-registry goal", async () => {
    const { fetchImpl } = fakeLLM(["problem_detection"]);
    const out = await inferGoalTargetDecision("Review the code quality problems in the discovery vessel", KR, { llmEndpoint: "http://llm.test", fetchImpl });
    expect(out.shapes).not.toEqual(["shellResult"]);
  });
});
