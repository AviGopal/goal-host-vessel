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

// Check-first test for gap a-news-question-targets-the-raw-search-results-so-no-step-synthesizes-an-answer.
//
// With the route above in place, the verbatim goal below inferred ["web_search"] and nothing
// else (goal_hash d0241cd4; node 1 dispatch 20345418, node 2 dispatch c91b2840, 9 and 13
// attempts, both reached:false). web_search returned real results every time, and the judge
// ruled each HOLLOW ("only links to news sources", "does not list the top ten headlines"). No
// step ever read those results and wrote the answer, because the target WAS the search
// result: once it was in the pool the walk had nothing left to produce.
//
// A news QUESTION asks for an answer composed from evidence. The search is the means; the
// deliverable is a written answer built from what the search returned. So the target is the
// search followed by the evidence-bound writer: llm_completion (or llmCompletion where only
// that is advertised). The walk already binds chain-produced evidence into that writer's
// prompt, and the satisfier takes targets in list order, so the search has to come first.
// llm_completion_dispatch is not that writer: it dispatches a named template and failed
// "Template not found" on this same goal.
//
// The targets are exact on purpose. Extra shapes make reach harder, not easier: every listed
// target has to be produced before the goal counts as reached.

const NEWS_QUESTION = "What are the top ten headlines for yesterday? And what are the 10 most important ongoing events and their updates?";

describe("a news question targets an answer written from the search results", () => {
  it("THE BREAK: the verbatim headlines question targets web_search, then llm_completion", async () => {
    const m = dispatcherModel();
    const d = await inferGoalTargetDecision(NEWS_QUESTION, KNOWN, { complete: m.complete });
    expect(d.shapes).toEqual(["web_search", "llm_completion"]);
    expect(m.calls()).toBe(0);
  });

  it("where only llmCompletion is advertised, the news question targets web_search, then llmCompletion", async () => {
    const m = dispatcherModel();
    const known = [...KNOWN.filter((s) => s !== "llm_completion"), "llmCompletion"];
    const d = await inferGoalTargetDecision(NEWS_QUESTION, known, { complete: m.complete });
    expect(d.shapes).toEqual(["web_search", "llmCompletion"]);
    expect(m.calls()).toBe(0);
  });

  it("a short news question also targets web_search, then llm_completion", async () => {
    const m = dispatcherModel();
    const d = await inferGoalTargetDecision("What are today's top stories?", KNOWN, { complete: m.complete });
    expect(d.shapes).toEqual(["web_search", "llm_completion"]);
    expect(m.calls()).toBe(0);
  });

  // Controls: these pass today and must keep passing.
  it("control: an ask to search and return the links keeps web_search alone", async () => {
    const m = dispatcherModel();
    const d = await inferGoalTargetDecision(
      "Search the web for the latest news about the Artemis program and return the links.",
      KNOWN, { complete: m.complete },
    );
    expect(d.shapes).toEqual(["web_search"]);
  });

  it("control: with no evidence-bound writer advertised, the news question does not fall back to the dispatcher", async () => {
    const m = dispatcherModel();
    const known = KNOWN.filter((s) => s !== "llm_completion" && s !== "llmCompletion");
    const d = await inferGoalTargetDecision(NEWS_QUESTION, known, { complete: m.complete });
    expect(d.shapes).toEqual(["web_search"]);
  });

  it("control: a definitional what-is question keeps the prose route", async () => {
    const m = dispatcherModel();
    const d = await inferGoalTargetDecision("What is an ephemeris?", KNOWN, { complete: m.complete });
    expect(d.shapes).toEqual(["llm_completion_dispatch"]);
    expect(m.calls()).toBe(0);
  });
});
