import { describe, it, expect } from "bun:test";
import { inferGoalTargetDecision } from "../src/goal-target-inference";

// Check-first test for gap inference-picks-a-dispatcher-shape-for-a-free-text-goal-so-web-search-is-never-tried.
//
// A time-relative news goal ("top ten headlines for yesterday") was inferred as
// ["llm_completion_dispatch"]: a dispatcher shape whose producer needs a template id the goal
// cannot supply, and a model cannot know yesterday's headlines anyway. web_search, which can
// answer it, was never tried. The deterministic web-search route only matched four fixed
// phrasings ("current events", "world news", "latest news", "what's happening in the world
// right now"), and only on the no-LLM empty fallback, so the LLM inferrer or the prose route
// decided first.
//
// The model stub below would answer llm_completion_dispatch; a news goal must be routed to
// web_search before it is consulted.

const KNOWN = [
  "web_search", "llm_completion_dispatch", "llm_completion", "shellResult",
  "web_resource", "http_response", "memoryNote_write", "fileContent", "activity_template",
];

function dispatcherModel() {
  let calls = 0;
  const complete = async (_prompt: string): Promise<string | null> => {
    calls++;
    return JSON.stringify({ target_shapes: ["llm_completion_dispatch"], confidence: 0.7 });
  };
  return { complete, calls: () => calls };
}

describe("news goals route to web_search before the model is asked", () => {
  it("yesterday's top headlines infer web_search without a model call", async () => {
    const m = dispatcherModel();
    const d = await inferGoalTargetDecision(
      "Give me the top ten headlines for yesterday, plus 10 ongoing events worth following.",
      KNOWN, { complete: m.complete },
    );
    expect(d.shapes[0]).toBe("web_search");
    expect(d.shapes).not.toContain("llm_completion_dispatch");
    expect(m.calls()).toBe(0);
  });

  it("a 'what is happening today, search the web' report goal infers web_search without a model call", async () => {
    const m = dispatcherModel();
    const d = await inferGoalTargetDecision(
      "What is happening today? This should search the web for multiple sources, get the current date and recent month / year. Then produce a report with the main headlines and some commentary on each.",
      KNOWN, { complete: m.complete },
    );
    expect(d.shapes[0]).toBe("web_search");
    expect(d.shapes).not.toContain("llm_completion_dispatch");
    expect(m.calls()).toBe(0);
  });

  it("summarizing today's news headlines is not routed to the prose model", async () => {
    const m = dispatcherModel();
    const d = await inferGoalTargetDecision("Summarize the main news headlines from today.", KNOWN, { complete: m.complete });
    expect(d.shapes[0]).toBe("web_search");
    expect(d.shapes).not.toContain("llm_completion_dispatch");
  });

  // Controls: these pass today and must keep passing.
  it("control: a definitional question still routes to the prose model", async () => {
    const m = dispatcherModel();
    const d = await inferGoalTargetDecision("Explain how photosynthesis works.", KNOWN, { complete: m.complete });
    expect(d.shapes).toEqual(["llm_completion_dispatch"]);
    expect(m.calls()).toBe(0);
  });

  it("control: without an advertised web_search producer a news goal is not routed to it", async () => {
    const m = dispatcherModel();
    const d = await inferGoalTargetDecision(
      "Give me the top ten headlines for yesterday, plus 10 ongoing events worth following.",
      KNOWN.filter((s) => s !== "web_search"), { complete: m.complete },
    );
    expect(d.shapes).not.toContain("web_search");
  });
});
