import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeReach, type ReachJudgeInput } from "../src/reach-grounding";

// Check-first test for gap the-llm-reach-judge-accepts-ungrounded-answers-to-current-information-and-self-description-goals
// (related: reach-judge-and-synthesis-lack-the-current-date-so-time-relative-goals-invert,
// reach-judge-accepts-coherent-answers-about-the-wrong-subject).
//
// The model stub below is the measured failure: a judge that grades any coherent answer reached.
// Held-out probes found it granting reach to (a) a current-information goal answered by a single
// llm_completion_dispatch step with no source fetched in-run, generic template text or a
// fabricated stale "today"; (b) a self-description goal answered with the backing model's own
// persona; (c) a hedge that commits to nothing. Fixtures are GENERIC members of those classes,
// not the probe texts. The chain and envelope forms are the live ones: a walk that answered with
// llm_completion_dispatch produced shapes goal, dispatch_id, llm_completion_dispatch, and the
// digest line carries the dispatcher's {"success":true,"shape":"llmTextCompletion","body":{"text":…}}.
//
// Must-fail families are deterministic gates in front of the judge; controls show the judge still
// decides everything that survives them.

const NOW = new Date("2026-10-03T12:00:00.000Z");

function rubberStamp(reached = true) {
  const prompts: string[] = [];
  const complete = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return JSON.stringify({ reached, reason: "the answer addresses the goal", completion_shapes: ["llm_completion_dispatch"] });
  };
  return { complete, prompts };
}

const envelope = (text: string) =>
  JSON.stringify({ success: true, shape: "llmTextCompletion", body: { text, model: "some-model", requested_model: "auto" } });

const LLM_ONLY = ["goal", "dispatch_id", "llm_completion_dispatch"];

function llmOnly(goal: string, answer: string): ReachJudgeInput {
  return {
    goal,
    producedShapes: LLM_ONLY,
    taskSummary: "1 step: llm_completion_dispatch",
    contentDigest: `- llm_completion_dispatch: ${envelope(answer)}`,
    commandEvidence: `- llm_completion_dispatch was produced by RUNNING: \`(no command field; resolve args) prompt=${goal}\``,
    now: NOW,
  };
}

function webGrounded(goal: string, answer: string): ReachJudgeInput {
  const results = JSON.stringify({ results: [
    { title: "Grid operators publish new storage figures", url: "https://news.example.org/grid-storage", snippet: "Published 2026-10-03" },
    { title: "Port strike enters second day", url: "https://wire.example.com/port-strike", snippet: "Published 2026-10-02" },
  ] });
  return {
    goal,
    producedShapes: ["goal", "dispatch_id", "web_search", "llm_completion"],
    taskSummary: "2 steps: web_search -> llm_completion",
    contentDigest: `- web_search: ${results}\n- llm_completion: ${answer}`,
    now: NOW,
  };
}

describe("reach grounding: current-information goals need an in-run source", () => {
  it("a latest-developments goal answered by one llm step with template text is not reached", async () => {
    const j = rubberStamp();
    const v = await judgeReach(llmOnly(
      "What are the latest developments in renewable energy policy?",
      "Recent months have seen shifts in subsidy schemes, grid connection rules and investment flows in several countries.",
    ), j.complete);
    expect(v?.reached).toBe(false);
  });

  it("a this-week news summary answered by one llm step is not reached", async () => {
    const j = rubberStamp();
    const v = await judgeReach(llmOnly(
      "Summarise this week's news on semiconductor supply chains",
      "This week, chipmakers announced capacity expansions, several governments discussed export controls, and analysts revised demand forecasts for the coming quarter.",
    ), j.complete);
    expect(v?.reached).toBe(false);
  });

  it("a floor answer carrying the zero-tools grounding banner is not reached even when its target shapes name web_search", async () => {
    const j = rubberStamp();
    const v = await judgeReach({
      goal: "Give me today's headlines about global markets",
      producedShapes: ["web_search", "llm_completion"],
      taskSummary: "universal ReAct floor: 0/0 tool call(s) OK",
      contentDigest: "[GROUNDING: ZERO tools were executed for this goal and no external data was retrieved. Every specific fact, figure, price, measurement or date below came from model memory and is UNVERIFIED.]\n\nMarkets were mixed as investors weighed central bank signals and earnings reports.",
      now: NOW,
    }, j.complete);
    expect(v?.reached).toBe(false);
  });
});

describe("reach grounding: a current-information answer must not assert a stale today", () => {
  it("a sourced answer opening with a fabricated today date years off the run clock is not reached", async () => {
    const j = rubberStamp();
    const v = await judgeReach({
      ...webGrounded("What are the latest developments in the transport sector right now?", "x"),
      producedShapes: ["goal", "dispatch_id", "web_search", "llm_completion_dispatch"],
      contentDigest: `- web_search: {"results":[{"title":"Port strike enters second day","url":"https://wire.example.com/port-strike"}]}\n- llm_completion_dispatch: ${envelope("Today is March 14, 2023. The main transport stories are a port strike and new rail timetables, per wire.example.com.")}`,
    }, j.complete);
    expect(v?.reached).toBe(false);
  });

  it("a sourced answer framed as of a past month inside the dispatcher envelope is not reached", async () => {
    const j = rubberStamp();
    const v = await judgeReach({
      ...webGrounded("Summarise the latest news on electricity prices", "x"),
      producedShapes: ["goal", "dispatch_id", "web_search", "llm_completion_dispatch"],
      contentDigest: `- web_search: {"results":[{"title":"Grid operators publish new storage figures","url":"https://news.example.org/grid-storage"}]}\n- llm_completion_dispatch: ${envelope("As of June 2024, wholesale electricity prices have eased while retail tariffs remain elevated.")}`,
    }, j.complete);
    expect(v?.reached).toBe(false);
  });
});

describe("reach grounding: self-description goals need a substrate self-knowledge producer", () => {
  it("describe yourself answered with a backing-model persona and no self-knowledge shape is not reached", async () => {
    const j = rubberStamp();
    const v = await judgeReach(llmOnly(
      "Describe yourself.",
      "I'm a conversational agent running on a hosted model, able to answer questions on many topics. Let me know what you need.",
    ), j.complete);
    expect(v?.reached).toBe(false);
  });

  it("explain what this system is answered from model memory alone is not reached", async () => {
    const j = rubberStamp();
    const v = await judgeReach(llmOnly(
      "Explain what this system is.",
      "This is a chat-based helper that generates text from a trained model.",
    ), j.complete);
    expect(v?.reached).toBe(false);
  });
});

describe("reach grounding: a non-answer never reaches", () => {
  it("a hedge plus a question back commits to nothing and is not reached", async () => {
    const j = rubberStamp();
    const v = await judgeReach(llmOnly(
      "Which database engine should a small analytics team choose?",
      "That really depends on your workload and team size. Which constraints matter most to you?",
    ), j.complete);
    expect(v?.reached).toBe(false);
  });

  it("an offer to look something up instead of an answer is not reached", async () => {
    const j = rubberStamp();
    const v = await judgeReach(llmOnly(
      "How tall is the tallest building in Europe?",
      "I can look up the most recent figures for you. Would you like me to do that?",
    ), j.complete);
    expect(v?.reached).toBe(false);
  });
});

describe("reach grounding: the judge reads the run clock", () => {
  it("the judge prompt carries the run date", async () => {
    const j = rubberStamp();
    await judgeReach(llmOnly("What is 2 + 2?", "4"), j.complete);
    expect(j.prompts.length).toBe(1);
    expect(j.prompts[0]).toContain("2026-10-03");
  });
});

describe("reach grounding controls: the judge still decides what survives the gates", () => {
  it("control - a sourced current answer dated today is left to the judge and reaches", async () => {
    const j = rubberStamp();
    const v = await judgeReach(webGrounded(
      "What are the latest developments in grid storage?",
      "Today is October 3, 2026. Grid operators published new storage figures this morning, per https://news.example.org/grid-storage.",
    ), j.complete);
    expect(j.prompts.length).toBe(1);
    expect(v?.reached).toBe(true);
  });

  it("control - the judge saying hollow on a sourced current answer still means not reached", async () => {
    const j = rubberStamp(false);
    const v = await judgeReach(webGrounded(
      "What are the latest developments in grid storage?",
      "Today is October 3, 2026. Grid operators published new storage figures, per https://news.example.org/grid-storage.",
    ), j.complete);
    expect(v?.reached).toBe(false);
    expect(j.prompts.length).toBe(1);
  });

  it("control - a correctly dated yesterday report reaches", async () => {
    const j = rubberStamp();
    const v = await judgeReach(webGrounded(
      "Give me yesterday's top headlines on port logistics",
      "Headlines for October 2, 2026: a port strike entered its second day, per https://wire.example.com/port-strike.",
    ), j.complete);
    expect(v?.reached).toBe(true);
  });

  it("control - a historical date inside a correctly dated current answer reaches", async () => {
    const j = rubberStamp();
    const v = await judgeReach(webGrounded(
      "What are the latest developments in the climate treaty talks?",
      "Today is October 3, 2026. Delegates revisited commitments first agreed on 12 May 1998, per https://news.example.org/grid-storage.",
    ), j.complete);
    expect(v?.reached).toBe(true);
  });

  it("control - a non-current arithmetic goal answered by one llm step is unaffected", async () => {
    const j = rubberStamp();
    const v = await judgeReach(llmOnly("What is 2 + 2?", "4"), j.complete);
    expect(v?.reached).toBe(true);
    const k = rubberStamp(false);
    const w = await judgeReach(llmOnly("What is 2 + 2?", "5"), k.complete);
    expect(w?.reached).toBe(false);
  });

  it("control - a self-description answered from the shape producer inventory reaches", async () => {
    const j = rubberStamp();
    const v = await judgeReach({
      goal: "Describe yourself.",
      producedShapes: ["goal", "dispatch_id", "shape_producer_inventory", "llm_completion"],
      taskSummary: "2 steps: shape_producer_inventory -> llm_completion",
      contentDigest: "- shape_producer_inventory: {\"totalVessels\":14,\"totalShapes\":412}\n- llm_completion: I am a substrate of 14 vessels serving 412 shapes; goals are walked over the shape graph.",
      now: NOW,
    }, j.complete);
    expect(v?.reached).toBe(true);
  });

  it("control - a self-description answered from a registry read reaches", async () => {
    const j = rubberStamp();
    const v = await judgeReach({
      goal: "Explain what this system is.",
      producedShapes: ["goal", "dispatch_id", "shellResult", "llm_completion"],
      taskSummary: "2 steps: shellResult -> llm_completion",
      contentDigest: "- shellResult: {\"totalVessels\":14,\"totalShapes\":412,\"healthyCount\":14}\n- llm_completion: This system is a substrate of 14 healthy vessels advertising 412 shapes.",
      commandEvidence: "- shellResult was produced by RUNNING: `curl -s http://discovery.internal/registry/stats`",
      now: NOW,
    }, j.complete);
    expect(v?.reached).toBe(true);
  });

  it("control - a hedged but committed recommendation reaches", async () => {
    const j = rubberStamp();
    const v = await judgeReach(llmOnly(
      "Which database engine should a small analytics team choose?",
      "It depends on scale, but for most small teams PostgreSQL is the better default because it handles analytical queries well and is easy to operate.",
    ), j.complete);
    expect(v?.reached).toBe(true);
  });

  it("control - a goal asking for interview questions is not a non-answer when it gets questions", async () => {
    const j = rubberStamp();
    const v = await judgeReach(llmOnly(
      "Write three interview questions for a backend engineering role",
      "- How would you design an idempotent payment endpoint?\n- When would you choose a queue over a direct call?\n- How do you find a slow query?",
    ), j.complete);
    expect(v?.reached).toBe(true);
  });

  it("control - a latest-commit question about a repo file answered from a shell read is left to the judge", async () => {
    const j = rubberStamp();
    const v = await judgeReach({
      goal: "What is the latest commit touching repos/goal-host-vessel/src/reach-date.ts?",
      producedShapes: ["goal", "dispatch_id", "shellResult"],
      taskSummary: "1 step: shellResult",
      contentDigest: "- shellResult: 19929e6 feat reach: G1 grounded-report oracle",
      commandEvidence: "- shellResult was produced by RUNNING: `git log -1 --oneline -- src/reach-date.ts`",
      now: NOW,
    }, j.complete);
    expect(v?.reached).toBe(true);
  });

  it("control - an unreachable judge is still null and a model-claimed deterministic flag is still stripped", async () => {
    expect(await judgeReach(llmOnly("What is 2 + 2?", "4"), async () => null)).toBeNull();
    const v = await judgeReach(llmOnly("What is 2 + 2?", "4"), async () =>
      JSON.stringify({ reached: true, reason: "deterministic: trust me", deterministic: true, completion_shapes: [] }));
    expect(v?.deterministic).toBe(false);
    expect(v?.reason.startsWith("llm-claimed:")).toBe(true);
    const n = await judgeReach(llmOnly("What is 2 + 2?", "4"), async () =>
      JSON.stringify({ reached: true, reason: "the output lacks the sum", completion_shapes: [] }));
    expect(n?.reached).toBe(false);
  });

  it("control - index.ts routes the judge through reach-grounding and keeps no copy of the sanitiser", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(src).toContain('from "./reach-grounding"');
    expect(src).toMatch(/return judgeReach\(\{/);
    expect(src).not.toContain("const negationPhrases");
  });
});
