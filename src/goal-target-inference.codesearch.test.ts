import { describe, it, expect } from "bun:test";
import { inferGoalTargetDecision } from "./goal-target-inference";

// The CODE-INVESTIGATION pre-LLM shortcut (2026-08-27): a code-origin investigation goal must
// route to code-search shapes, NOT to the trace store (the observed below-ReAct-floor misroute),
// and must NOT hijack the recipe/registry filesystem-count routes. These cases all hit a pre-LLM
// shortcut, so the (dummy) llm endpoint is never called.
const KNOWN = [
  "shellResult", "codeSearchResult", "source_code", "code_find_function",
  "execution_trace", "trace_search", "memoryNote_write",
];
const OPTS = { llmEndpoint: "http://unused.invalid" }; // never reached on a shortcut hit

const route = async (goal: string): Promise<string[]> =>
  (await inferGoalTargetDecision(goal, KNOWN, OPTS)).shapes;

describe("goal-target-inference: code-investigation route", () => {
  it("routes a 'search the codebase / root cause' investigation to codeSearchResult", async () => {
    const s = await route(
      "Investigate why trace records for the execution id exec_test_1 are being emitted. " +
        "Search the codebase for what creates or dispatches an execution named exec_test_1, and " +
        "for where the TranslatingTraceSink endpoint is configured, then report the root cause.",
    );
    expect(s[0]).toBe("codeSearchResult");
  });

  it("routes 'find where X is configured in the source' to codeSearchResult", async () => {
    const s = await route("Find where the TranslatingTraceSink endpoint is configured in the source code");
    expect(s[0]).toBe("codeSearchResult");
  });

  it("still fires when the goal NAMES a vessel (the NOT_CODE 'vessels' over-match regression)", async () => {
    // Regression for the live 2026-08-27 miss: "goal-host-vessel" contains "vessel", which an
    // over-broad NOT_CODE guard matched, wrongly suppressing the shortcut. An investigation goal
    // routinely names a vessel; it must still route to code-search.
    const s = await route(
      "Investigate why trace records are emitted from the live goal-host-vessel. Search the " +
        "codebase for what creates exec_test_1 and report the root cause.",
    );
    expect(s[0]).toBe("codeSearchResult");
  });

  it("does NOT hijack a recipe file-extension count goal (stays shellResult)", async () => {
    const s = await route("How many distinct file extensions appear under repos/discovery-vessel/src?");
    expect(s[0]).toBe("shellResult");
  });

  it("does NOT hijack a registry count goal (stays shellResult)", async () => {
    const s = await route("How many vessels are currently registered in the discovery registry?");
    expect(s[0]).toBe("shellResult");
  });
});
