import { describe, it, expect } from "bun:test";
import { inferGoalTargetShapes, goalHashOf } from "../src/goal-target-inference";

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
