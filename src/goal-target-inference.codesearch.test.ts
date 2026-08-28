import { describe, it, expect } from "bun:test";
import { inferGoalTargetDecision, isGapInvestigationGoal, extractInvestigationSymbols } from "./goal-target-inference";

// The CODE-INVESTIGATION pre-LLM shortcut (2026-08-27): a code-origin investigation goal must
// route to code-search shapes, NOT to the trace store (the observed below-ReAct-floor misroute),
// and must NOT hijack the recipe/registry filesystem-count routes. These cases all hit a pre-LLM
// shortcut, so the (dummy) llm endpoint is never called.
const KNOWN = [
  "shellResult", "codeSearchResult", "source_code", "code_find_function",
  "execution_trace", "trace_search", "memoryNote_write",
];
const OPTS = { llmEndpoint: "http://unused.invalid" }; // never reached on a shortcut hit

const decide = async (goal: string) => await inferGoalTargetDecision(goal, KNOWN, OPTS);
// The code-investigation route prefers shellResult (a grep) as primary but is DISTINGUISHED from
// the plain filesystem/recipe shellResult routes by carrying the structured code-search shapes as
// alternatives. So "is this the code-investigation route?" = primary shellResult AND codeSearchResult
// present in alternatives.
const isCodeInvestigation = (d: { shapes: string[]; alternatives: string[][] }) =>
  d.shapes[0] === "shellResult" && d.alternatives.some((a) => a.includes("codeSearchResult"));

describe("goal-target-inference: code-investigation route", () => {
  it("routes a 'search the codebase / root cause' investigation to shellResult(grep)+code-search alts", async () => {
    const d = await decide(
      "Investigate why trace records for the execution id exec_test_1 are being emitted. " +
        "Search the codebase for what creates or dispatches an execution named exec_test_1, and " +
        "for where the TranslatingTraceSink endpoint is configured, then report the root cause.",
    );
    expect(isCodeInvestigation(d)).toBe(true);
  });

  it("routes 'find where X is configured in the source' to the code-investigation route", async () => {
    const d = await decide("Find where the TranslatingTraceSink endpoint is configured in the source code");
    expect(isCodeInvestigation(d)).toBe(true);
  });

  it("still fires when the goal NAMES a vessel (the NOT_CODE 'vessels' over-match regression)", async () => {
    // Regression for the live 2026-08-27 miss: "goal-host-vessel" contains "vessel", which an
    // over-broad NOT_CODE guard matched, wrongly suppressing the shortcut.
    const d = await decide(
      "Investigate why trace records are emitted from the live goal-host-vessel. Search the " +
        "codebase for what creates exec_test_1 and report the root cause.",
    );
    expect(isCodeInvestigation(d)).toBe(true);
  });

  it("does NOT hijack a recipe file-extension count goal (shellResult, NO code-search alts)", async () => {
    const d = await decide("How many distinct file extensions appear under repos/discovery-vessel/src?");
    expect(d.shapes[0]).toBe("shellResult");
    expect(isCodeInvestigation(d)).toBe(false);
  });

  it("does NOT hijack a registry count goal (shellResult, NO code-search alts)", async () => {
    const d = await decide("How many vessels are currently registered in the discovery registry?");
    expect(d.shapes[0]).toBe("shellResult");
    expect(isCodeInvestigation(d)).toBe(false);
  });
});

// The gap-investigation grounding extension (2026-08-28): the substrate's OWN gap-lifecycle loop
// autonomously dispatches goals shaped "investigate and decompose gap <gap-id>" — confirmed live,
// with no operator dispatch — but this phrasing does NOT match isCodeInvestigationGoal, so it fell
// outside the 2026-08-27 grounding fixes and reached HOLLOW (groundedOk=0) through the
// un-discriminating LLM judge. isGapInvestigationGoal + extractInvestigationSymbols are additive
// (seed + citation-oracle grounding only, per the module-level comment) — routing/satisfier-
// suppression must remain keyed to isCodeInvestigationGoal alone, unchanged by this extension.
describe("goal-target-inference: gap-investigation grounding (additive, seed+oracle only)", () => {
  it("recognizes the autonomous gap-lifecycle phrasing", () => {
    expect(isGapInvestigationGoal("investigate and decompose gap systematic-failure-universal-tool-fallback-zero")).toBe(true);
    expect(isGapInvestigationGoal("decompose the stuck gap narrowing-a-chronically-stuck-composer")).toBe(true);
  });

  it("does not misfire on an ordinary code-investigation or count goal", () => {
    expect(isGapInvestigationGoal("Search the codebase for what creates TranslatingTraceSink and report the root cause file:line.")).toBe(false);
    expect(isGapInvestigationGoal("How many vessels are currently registered in the discovery registry?")).toBe(false);
  });

  it("extracts a real, grep-groundable activity id from a hyphenated gap slug", () => {
    const syms = extractInvestigationSymbols("investigate and decompose gap systematic-failure-universal-tool-fallback-zero");
    expect(syms).toContain("universal-tool-fallback");
  });

  it("prefers camelCase/snake_case source symbols over slug spans when both are present", () => {
    const syms = extractInvestigationSymbols("investigate and decompose gap why TranslatingTraceSink keeps failing");
    expect(syms).toEqual(["TranslatingTraceSink"]);
  });

  it("abstains (empty) on a gap-investigation goal with no groundable slug or symbol", () => {
    expect(extractInvestigationSymbols("investigate and decompose gap ab")).toEqual([]);
  });

  it("abstains (empty) on a non-gap-investigation goal with no camelCase/snake_case symbol", () => {
    expect(extractInvestigationSymbols("What is the delta v required for a LEO to Io orbit insertion?")).toEqual([]);
  });
});
