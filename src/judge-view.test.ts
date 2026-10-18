// The judge view (judge-view.ts). Fixture: cea3f4a4 attempt 1 (#72, output-shapes track 4) — a
// 4,218-char grounded report the parent's view cut at 1,500 chars behind a 7,247-char
// activity_template catalogue and error rows; the judge rejected it as "missing a coherent report".
import { describe, expect, test } from "bun:test";
import { buildJudgeView, restrictCompletionShapes, evidenceLines, isProvenanceStub, DELIVERABLE_CAP } from "./judge-view";

const REPORT = "Today is Thursday, October 1, 2026. Main headlines:\n" +
  Array.from({ length: 12 }, (_, i) => `${i + 1}. FlyDubai flight dropped 14,125 feet in just 29 seconds (https://www.nbcnews.com/item-${i}). Commentary: ${"a sober note on what this means. ".repeat(8)}`).join("\n");
const SEARCH = { results: [
  { title: "FlyDubai jet plunges 14,125 feet", url: "https://www.nbcnews.com/item-0", snippet: "x".repeat(900) },
  { title: "Iran war live", url: "https://www.aljazeera.com/news/liveblog/2026/10/1/iran-war-live", snippet: "y".repeat(900) },
] };
const POOL = [
  { shape: "goal", content: { goal: "What is happening today?" } },
  { shape: "activity_template", content: { catalogue: "t".repeat(7247) } },
  { shape: "error", content: { error: "API key missing" } },
  { shape: "web_search", content: SEARCH },
  { shape: "webSearchResult", content: SEARCH },
  { shape: "problem_detection", content: { producedBy: "activity:x", executionId: "exec_1" } },
  { shape: "llm_completion", content: { resolved: true, content: REPORT } },
];

describe("buildJudgeView", () => {
  const v = buildJudgeView(POOL, new Set());
  test("#72: the report comes FIRST and WHOLE (the parent showed ≤1,500 of 4,218+ chars)", () => {
    expect(REPORT.length).toBeGreaterThan(4000);
    expect(v.digest.startsWith(`- llm_completion: ${REPORT}`)).toBe(true);
    expect(v.deliverableCut).toBe(false);
  });
  test("bookkeeping shapes and provenance stubs are excluded", () => {
    expect(v.digest).not.toContain("activity_template");
    expect(v.digest).not.toContain("API key missing");
    expect(v.digest).not.toContain("exec_1");
    expect(v.digest).not.toContain("- goal:");
  });
  test("evidence is title — url lines, and the web_search / webSearchResult duplicate is folded", () => {
    expect(v.digest).toContain("- web_search: FlyDubai jet plunges 14,125 feet — https://www.nbcnews.com/item-0");
    expect(v.digest).not.toContain("- webSearchResult:");
    expect(v.digest).not.toContain("xxxxxxxxxx");
  });
  test("a deliverable larger than its budget is CUT and flagged (the §9.2 abstain input)", () => {
    const big = buildJudgeView([{ shape: "llm_completion", content: "r".repeat(DELIVERABLE_CAP + 10) }], new Set());
    expect(big.deliverableCut).toBe(true);
    expect(big.cuts[0]).toEqual({ shape: "llm_completion", shown: DELIVERABLE_CAP, produced: DELIVERABLE_CAP + 10 });
  });
  test("a terminal shape named by the walk is a deliverable too", () => {
    const t = buildJudgeView([{ shape: "shellResult", content: "z".repeat(3000) }, { shape: "memoryNote", content: "n".repeat(3000) }], new Set(["memoryNote"]));
    expect(t.digest.startsWith(`- memoryNote: ${"n".repeat(3000)}`)).toBe(true);
    expect(t.cuts).toEqual([{ shape: "shellResult", shown: 1500, produced: 3000 }]);
  });
  test("an error-only pool is still shown, so the all-error-envelope pre-check can fire", () => {
    const e = buildJudgeView([{ shape: "goal", content: "g" }, { shape: "error", content: { error: "boom" } }], new Set());
    expect(e.digest).toBe(`- error: {"error":"boom"}`);
  });
  test("executor results render stdout at both sites", () => {
    expect(buildJudgeView([{ shape: "shellResult", content: { stdout: "42\n", stderr: "cmd echo" } }], new Set()).digest).toBe("- shellResult: 42");
  });
  test("helpers", () => {
    expect(isProvenanceStub({ producedBy: "a", executionId: "b" })).toBe(true);
    expect(isProvenanceStub({ producedBy: "a", content: "b" })).toBe(false);
    expect(evidenceLines(JSON.stringify(SEARCH))).toHaveLength(2);
  });
});

describe("a targeted shape wins over the exclusion list", () => {
  test("test_suite / activity_template as the goal's target is the deliverable, not bookkeeping", () => {
    const v = buildJudgeView([{ shape: "test_suite", content: { passed: 940, failed: 3 } }, { shape: "activity_template", content: { id: "t" } }], new Set(), new Set(["test_suite"]));
    expect(v.digest).toBe('- test_suite: {"passed":940,"failed":3}');
  });
  // A report whose decisive key sits past PER_SHAPE_CAP: the goal's only target, not terminal.
  const REPORT_JSON = JSON.stringify({ summary: "s".repeat(1600), checks: Array.from({ length: 40 }, (_, i) => ({ id: i, ok: true })), failing_invariants: ["relay-ack-before-commit"] });
  test("a targeted non-terminal report is the deliverable, read whole (parent: clipped at 1,500 in rest, silently)", () => {
    expect(REPORT_JSON.indexOf("failing_invariants")).toBeGreaterThan(1500);
    const v = buildJudgeView([{ shape: "federation_verification_report", content: REPORT_JSON }], new Set(), new Set(["federation_verification_report"]));
    expect(v.digest).toContain("failing_invariants");
    expect(v.deliverableCut).toBe(false);
    expect(v.cuts).toEqual([]);
    expect(v.deliverableShapes).toEqual(["federation_verification_report"]);
  });
  test("a targeted report larger than the deliverable budget is a DELIVERABLE cut (parent: a silent rest cut)", () => {
    const v = buildJudgeView([{ shape: "federation_verification_report", content: "r".repeat(DELIVERABLE_CAP + 10) }], new Set(), new Set(["federation_verification_report"]));
    expect(v.deliverableCut).toBe(true);
    expect(v.cuts[0]).toEqual({ shape: "federation_verification_report", shown: DELIVERABLE_CAP, produced: DELIVERABLE_CAP + 10 });
  });
  test("control: the same report named terminal reads the same; a non-target shape is still clipped at PER_SHAPE_CAP", () => {
    const t = buildJudgeView([{ shape: "federation_verification_report", content: REPORT_JSON }], new Set(["federation_verification_report"]));
    expect(t.digest).toContain("failing_invariants");
    expect(t.deliverableCut).toBe(false);
    const r = buildJudgeView([{ shape: "shellResult", content: "z".repeat(3000) }], new Set(), new Set(["federation_verification_report"]));
    expect(r.cuts).toEqual([{ shape: "shellResult", shown: 1500, produced: 3000 }]);
    expect(r.deliverableCut).toBe(false);
  });
  test("a target that is a deliverable only by targeting keeps its structure (the verbatim-read oracle parses fileContent's path)", () => {
    const fc = { shape: "fileContent", path: "/workspace/x/marker.txt", content: "marker-line\n" };
    const v = buildJudgeView([{ shape: "fileContent", content: fc }], new Set(), new Set(["fileContent"]));
    expect(v.digest).toBe(`- fileContent: ${JSON.stringify(fc)}`);
  });
  test("restrictCompletionShapes keeps a bookkeeping-named shape the deliverables name", () => {
    expect(restrictCompletionShapes(["test_suite", "error"], new Set(["test_suite", "error"]), false, new Set(["test_suite"]))).toEqual(["test_suite"]);
  });
});

describe("restrictCompletionShapes (completion_shapes chosen in code)", () => {
  const produced = new Set(["goal", "activity_template", "error", "web_search", "llm_completion"]);
  test("the judge's junk and invented names are dropped (14/61 named activity_template, 5/61 error)", () => {
    expect(restrictCompletionShapes(["activity_template", "error", "llm_completion", "headlines_summary"], produced, false)).toEqual(["llm_completion"]);
  });
  test("deterministic oracles keep the shapes their code chose", () => {
    expect(restrictCompletionShapes(["bind:memoryNote.body<-llmCompletion"], produced, true)).toEqual(["bind:memoryNote.body<-llmCompletion"]);
  });
});
