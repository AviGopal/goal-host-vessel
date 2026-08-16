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

// REGRESSION (2026-08-04, observed live): a compute-then-emit COMPOSITION must not be
// truncated to its compute half by a deterministic pre-LLM shortcut. Live evidence:
// "Write a memory note recording the count of TypeScript files in repos/goal-host-vessel/src"
// hit the FILE-SYSTEM AGGREGATE shortcut, planned ["shellResult"], produced ["shellResult"],
// was judged REACHED — and no memory note was ever written. Each shortcut's ad-hoc write
// excluder (`write\s+(?:a\s+)?(?:note|file|concept)`) was defeated by one qualifier:
// "write a MEMORY note" slipped through while "write a note" was caught. Plan-vs-observed
// reconciliation is blind to this because BOTH sides derive from the same truncated plan.
describe("inferGoalTargetDecision — compute-then-emit composition guard", () => {
  const KC = ["shellResult", "memoryNote_write", "concept_write", "source_code", "substrateGap_write"];
  const throwLLM = (async () => { throw new Error("shortcut fired on a COMPOSITION — the write clause was dropped"); }) as unknown as typeof fetch;

  // Each of these both computes AND asks to persist, so the deterministic shortcuts must
  // stand down and let the LLM (whose COMPOSITION RULE returns both shapes) decide.
  const COMPOSITIONS = [
    "Write a memory note recording the current count of TypeScript files in repos/goal-host-vessel/src.",
    "Count the lines in repos/activity-api/src/index.ts and write the number to a memory note",
    "count open substrateGaps by category and save the result as a concept",
    "how many vessels are registered? store the answer in an obsidian note",
    "sum failed_attempts for missing_capability gaps and record it in a note",
  ];
  for (const goal of COMPOSITIONS) {
    it(`does NOT truncate to a single compute shape: ${goal.slice(0, 52)}…`, async () => {
      // A shortcut firing would return synchronously without touching the LLM; throwLLM
      // makes that failure loud instead of silently yielding ["shellResult"].
      const out = await inferGoalTargetDecision(goal, KC, { llmEndpoint: "http://llm.test", fetchImpl: throwLLM })
        .catch(() => ({ shapes: ["__llm_was_called__"], confidence: 0, alternatives: [] }));
      expect(out.shapes).not.toEqual(["shellResult"]);
    });
  }

  // The shortcuts exist to stop confabulation on pure computes — guard against
  // over-suppression, which would regress that.
  const PURE_COMPUTES = [
    "Count the number of TypeScript files under repos/goal-host-vessel/src and report the number.",
    "How many vessels are currently registered in the discovery registry? Report the number.",
    "count open substrateGaps by category top 3",
  ];
  for (const goal of PURE_COMPUTES) {
    it(`still routes deterministically (no over-suppression): ${goal.slice(0, 52)}…`, async () => {
      const out = await inferGoalTargetDecision(goal, KC, { llmEndpoint: "http://llm.test", fetchImpl: throwLLM });
      expect(out.shapes).toEqual(["shellResult"]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EDIT RULE — the prompt must distinguish CHANGING code from ANALYSING it.
//
// Two live autonomous attempts at a repair goal both routed to non-edit shapes
// (a write-bridge, then problem_detection) and the walk then honestly reported
// "no template produces the inferred target shapes". The prompt taught analysis
// by example and never mentioned editing.
// ─────────────────────────────────────────────────────────────────────────────
function capturingLLM(targetShapes: unknown) {
  let prompt = "";
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    prompt = JSON.parse(init.body).prompt as string;
    return {
      ok: true,
      json: async () => ({ body: { content: JSON.stringify({ target_shapes: targetShapes }) } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, prompt: () => prompt };
}

describe("edit-intent rule in the inference prompt", () => {
  it("names the producible edit shapes when one is available", async () => {
    const { fetchImpl, prompt } = capturingLLM(["fs_edit"]);
    await inferGoalTargetShapes("fix the bug in the writer", [...KNOWN, "fs_edit"], {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(prompt()).toContain("CHANGING code is not ANALYSING code");
    expect(prompt()).toContain("fs_edit");
  });

  it("stays SILENT when no edit shape is producible", async () => {
    // Same discipline as the shellResult rule: never steer the model toward a
    // shape the substrate cannot serve, or it returns an unroutable target.
    const { fetchImpl, prompt } = capturingLLM(["problem_detection"]);
    await inferGoalTargetShapes("fix the bug in the writer", KNOWN, {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(prompt()).not.toContain("CHANGING code is not ANALYSING code");
  });

  it("warns that analysis shapes report rather than repair", async () => {
    const { fetchImpl, prompt } = capturingLLM(["fs_edit"]);
    await inferGoalTargetShapes("repair it", [...KNOWN, "fs_edit"], {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    // The exact failure seen live: problem_detection chosen for a repair goal.
    expect(prompt()).toContain("problem_detection");
    expect(prompt()).toContain("leaves the defect in place");
  });

  it("still allows BOTH when a goal changes code and reports on it", async () => {
    const { fetchImpl, prompt } = capturingLLM(["fs_edit", "problem_detection"]);
    await inferGoalTargetShapes("fix it and report what you changed", [...KNOWN, "fs_edit"], {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(prompt()).toContain("return BOTH shapes");
  });

  it("the decision path carries the rule too, not just the shapes path", async () => {
    const { fetchImpl, prompt } = capturingLLM(["fs_edit"]);
    await inferGoalTargetDecision("fix the writer", [...KNOWN, "fs_edit"], {
      llmEndpoint: "http://llm.test",
      fetchImpl,
    });
    expect(prompt()).toContain("CHANGING code is not ANALYSING code");
  });
});

// ── SHORTCUT DECISIONS MUST REACH THE CACHE ─────────────────────────────────
// The deterministic pre-LLM shortcuts used to return BEFORE `decisionCache` was
// even declared, so they returned a real decision (confidence 0.6-0.8) and cached
// nothing. Only the slow LLM path wrote. Both readers (recordGoalPath and the
// dispatch record) look the decision up by goal hash and coalesce a miss to null,
// so every shortcut-routed goal persisted `inference_confidence: null` — a column
// absent exactly where the decision was most confident. Every exit now routes
// through remember(), which also makes shortcuts added later correct by default.
describe("shortcut decisions populate the decision cache", () => {
  const shapes = ["shellResult", "memoryNote_write", "fileEditResult"];
  const complete = async () => null; // never reached by a shortcut

  it("a deterministic shortcut caches its decision, with its real confidence", async () => {
    const cache = new Map<string, GoalTargetDecision>();
    const goal = "how many substrate gaps are there";
    const d = await inferGoalTargetDecision(goal, shapes, { complete, decisionCache: cache });
    expect(d.confidence).toBeGreaterThan(0);
    // THE REGRESSION: this used to be 0 — the shortcut returned without caching.
    expect(cache.size).toBe(1);
    const cached = [...cache.values()][0]!;
    expect(cached.confidence).toBe(d.confidence);
    expect(cached.shapes).toEqual(d.shapes);
  });

  it("the cached entry is what a later lookup returns — no null coalesce", async () => {
    const cache = new Map<string, GoalTargetDecision>();
    const goal = "count the activity templates";
    const first = await inferGoalTargetDecision(goal, shapes, { complete, decisionCache: cache });
    const second = await inferGoalTargetDecision(goal, shapes, { complete, decisionCache: cache });
    expect(second).toEqual(first);
    expect(cache.size).toBe(1);
  });

  it("a goal that produces NO decision does not pollute the cache", async () => {
    const cache = new Map<string, GoalTargetDecision>();
    await inferGoalTargetDecision("", shapes, { complete, decisionCache: cache });
    expect(cache.size).toBe(0);
  });

  it("works without a cache — the helper is a no-op when none is supplied", async () => {
    const d = await inferGoalTargetDecision("how many gaps are there", shapes, { complete });
    expect(d.shapes.length).toBeGreaterThan(0);
  });
});

// A QUESTION ABOUT THE PRESENT STATE OF THE WORLD IS NOT A PROSE QUESTION (2026-08-16).
//
// "What is the distance from Earth to Io right now, in astronomical units?" matched the
// explanatory lead on "what is" and nothing in NOT_PROSE_RE, so it routed deterministically to
// llm_completion_dispatch — "ask a model" — for 45+ dispatches. A model cannot know a
// time-varying physical quantity: that answer is a MEASUREMENT. The walk had a working
// trust-gated fetcher the whole time and never reached it, because inference had already
// decided the goal was definitional.
//
// The discrimination is temporal deixis, NOT subject matter. These tests pin both directions,
// because a guard that swallowed genuine prose questions would trade one failure for another.
describe("inferGoalTargetDecision — live-measurement questions are not prose questions", () => {
  const KM = ["shellResult", "web_resource", "http_response", "llm_completion_dispatch"];
  const throwLLM = (async () => { throw new Error("LLM should not be needed to classify these"); }) as unknown as typeof fetch;

  it("does NOT route the Io distance question to the prose target", async () => {
    const { fetchImpl } = fakeLLM(["shellResult"]);
    const out = await inferGoalTargetDecision(
      "What is the distance from Earth to Io right now, in astronomical units?",
      KM,
      { llmEndpoint: "http://llm.test", fetchImpl },
    );
    expect(out.shapes).not.toEqual(["llm_completion_dispatch"]);
  });

  it("catches the temporal-deixis variants that all mean 'measure it now'", async () => {
    for (const goal of [
      "What is the distance from Earth to Mars currently?",
      "What is the current distance from Earth to Jupiter?",
      "What is Io's position at this moment?",
      "What is the temperature in Reykjavik right now?",
    ]) {
      const { fetchImpl } = fakeLLM(["shellResult"]);
      const out = await inferGoalTargetDecision(goal, KM, { llmEndpoint: "http://llm.test", fetchImpl });
      expect(out.shapes).not.toEqual(["llm_completion_dispatch"]);
    }
  });

  it("catches a measurement noun paired with a unit, even without a time word", async () => {
    const { fetchImpl } = fakeLLM(["shellResult"]);
    const out = await inferGoalTargetDecision(
      "What is the distance from Earth to Io in astronomical units?",
      KM,
      { llmEndpoint: "http://llm.test", fetchImpl },
    );
    expect(out.shapes).not.toEqual(["llm_completion_dispatch"]);
  });

  // THE OTHER DIRECTION. A genuine definitional question must still take the prose route —
  // deterministically, without an LLM call — or this guard has simply broken a working path.
  it("STILL routes a genuine definitional question to the prose target, with no LLM call", async () => {
    const out = await inferGoalTargetDecision(
      "Explain what an ephemeris is.",
      KM,
      { llmEndpoint: "http://llm.test", fetchImpl: throwLLM },
    );
    expect(out.shapes).toEqual(["llm_completion_dispatch"]);
  });

  it("STILL routes 'what is X' about a concept, not a measurement", async () => {
    const out = await inferGoalTargetDecision(
      "What is an astronomical unit?",
      KM,
      { llmEndpoint: "http://llm.test", fetchImpl: throwLLM },
    );
    expect(out.shapes).toEqual(["llm_completion_dispatch"]);
  });
});
