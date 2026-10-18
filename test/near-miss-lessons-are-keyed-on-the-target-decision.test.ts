// A LESSON FROM ANOTHER GOAL IS KEYED ON THE TARGET DECISION, AND SAYS IT IS ANOTHER GOAL.
//
// Measured: the near-miss key was the goal's first word plus the next token, so every "What is …" goal shared the
// class "what". "What is this about? dispatch id: <uuid>" was handed a deterministic lesson from "What is the weather
// like in Spain?" as "(a similar goal)", searched the Spain question, and was judged as it. Its concept recall also
// searched a letter run of the dispatch id ("acda" of 16acda74-…) as if it were a subject.
//
// Now: "similar" is the same goal-target-inference decision (a set made only of writer/evidence/shell/seed shapes keys
// nothing); a recalled line carries the other goal's text labelled "a DIFFERENT goal"; ids are stripped before recall
// and before the content check; and a synthesised search query that shares no content word with the dispatch's goal is
// flagged, counted and logged (observe, never block).
//
// Hermetic like failed-trace-reason.test.ts: fetch refused, a temp failure-memory file, dynamic import.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "near-miss-lessons-"));
process.env["GOAL_FAILURE_MEMORY_PATH"] = join(TMP, "failure-memory.jsonl");
process.env["REACHED_CMD_CACHE_PATH"] ||= join(TMP, "reached-commands.jsonl");
process.env["REACH_VERDICT_SPOOL_PATH"] ||= join(TMP, "reach-spool.jsonl");
process.env["MEM_DUMP_PATH"] ||= join(TMP, "mem-dump.json");
process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";

const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new TypeError("fetch refused (test: no network)"); }) as unknown as typeof fetch);
const m = await import("../src/index");
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
const FLOOR_CTX = readFileSync(join(import.meta.dir, "..", "src", "floor-walk-context.ts"), "utf-8");
// The pure half is imported lazily so the index-driven must-fails below report their own red on a tree without it.
const fr = async () => await import("../src/failure-recall");

afterAll(() => {
  fetchSpy.mockRestore();
  rmSync(TMP, { recursive: true, force: true });
});

const UUID = "16acdaef-0b3c-4d2e-9f1a-2b3c4d5e6f70";
const ABOUT = `What is this about? dispatch id: ${UUID}`;
const SPAIN = "What is the weather like in Spain?";
const SPAIN_REASON = "deterministic:no-numeric-answer — the answer gave no temperature for Spain";
// Same work, different wording, same target decision.
const COUNT_A = "Count the open substrate gaps grouped by their class (near-miss fixture)";
const COUNT_B = "How many substrate gaps are open per class? (near-miss fixture)";
const COUNT_REASON = "deterministic:count-mismatch — reported 41 open gaps, the store lists 42";
type Rec = { goal?: string; reason: string };
const remember = (goal: string, reason: string, decided: string[]) =>
  (m.rememberGoalFailure as unknown as (g: string, r: string, p: string, s: string[], a: number, d: string[]) => void)(goal, reason, "satisfier:fixture", decided, 1, decided);
const recall = (goal: string, targets: string[]) =>
  (m.recallGoalFailures as unknown as (g: string, t: string[]) => { exact: Rec[]; near: Rec[] })(goal, targets);

remember(SPAIN, SPAIN_REASON, ["webSearchResult"]);
remember(COUNT_A, COUNT_REASON, ["substrateGap"]);

describe("near-miss lessons are keyed on the target decision, never on word tokens", () => {
  test("[MUST-FAIL] 'What is this about? dispatch id: …' and 'What is the weather like in Spain?' share no lesson, even when both infer the same writer/evidence target", () => {
    for (const targets of [["llm_completion"], ["webSearchResult"], []]) {
      const near = recall(ABOUT, targets).near;
      expect(near.some((r) => r.reason === SPAIN_REASON)).toBe(false);
    }
  });

  test("[MUST-FAIL] two goals with the same target decision and different wording DO share one, labelled with the other goal's text", async () => {
    const near = recall(COUNT_B, ["substrateGap"]).near;
    expect(near.map((r) => r.reason)).toContain(COUNT_REASON);
    const { failureFeedbackText } = await fr();
    const text = failureFeedbackText([], near as never);
    expect(text).toContain(`a DIFFERENT goal: "${COUNT_A}" failed because ${COUNT_REASON}`);
    expect(text).not.toContain("a similar goal");
  });

  test("[CONTROL] a different specific target decision shares nothing", () => {
    expect(recall(COUNT_B, ["memoryNote"]).near.some((r) => r.reason === COUNT_REASON)).toBe(false);
  });

  test("[CONTROL, learn] an exact-hash lesson for the same goal still feeds attempt 1", () => {
    expect(recall(SPAIN, ["webSearchResult"]).exact.map((r) => r.reason)).toContain(SPAIN_REASON);
    expect(recall(COUNT_A, []).exact.map((r) => r.reason)).toContain(COUNT_REASON);
    // The exact path is the goal hash, unchanged, and priorFailureFeedbackFor still renders it as "this exact goal".
    expect(INDEX).toContain("const exact = exactFailuresSince(goalFailureMemory.get(hash) ?? [], since(hash));");
  });

  test("[MUST-FAIL] the word-token class key is retired, and the decision is recorded and reloaded", () => {
    expect(INDEX).not.toContain("function goalClassTokenOf(");
    expect(INDEX).not.toContain("classToken");
    expect(INDEX).toContain("if (decided && decided.length > 0) rec.inferred = decided.slice(0, 8);");
    expect(INDEX).toContain("...(Array.isArray(o.inferred) ? { inferred: o.inferred } : {})");
    // Recomputed once inference decides, so a first-seen goal's attempt 1 gets its near-miss lessons.
    expect(INDEX).toMatch(/goalTargetDecision = decision;\n\s+if \(decision\.shapes\.length > 0\) seededOutputShapes = decision\.shapes;\n[\s\S]{0,400}const _pfNow = recallGoalFailures\(goal\);/);
  });

  test("[MUST-FAIL] the reader is told a DIFFERENT goal's line is not this goal (synthesis preamble and floor block)", () => {
    expect(INDEX).not.toContain("Earlier attempts at this goal (or a similar one)");
    expect(INDEX).toContain('(a line naming "a DIFFERENT goal" is about that goal, not this one: take its defect, never its subject)');
    expect(FLOOR_CTX).toContain('(a line naming "a DIFFERENT goal" is about that goal, not this one: take its defect, never its subject)');
  });
});

describe("dispatch ids are stripped before recall", () => {
  test("[MUST-FAIL] the uuid never appears as a concept-recall term", async () => {
    const { contentTermsOf, stripDispatchIds } = await fr();
    const terms = contentTermsOf(ABOUT);
    expect(terms).toEqual(["about"]);
    for (const part of UUID.split("-")) expect(terms.some((t) => part.includes(t))).toBe(false);
    expect(stripDispatchIds(ABOUT)).toBe("What is this about?");
    // Both concept-recall sites read the stripped goal.
    expect(INDEX).toContain("const _terms = contentTermsOf(goal);");
    expect(INDEX).toContain('const _recallRows = await recallConceptRows(stripDispatchIds(goal), _recallK, 10_000, { shape: "shape_description", include_global: true });');
  });

  test("[CONTROL] ordinary words, all-letter hex words and short numbers are kept", async () => {
    const { stripDispatchIds } = await fr();
    expect(stripDispatchIds("decode the facade deadbeef in 2026 for gap route-edit")).toBe("decode the facade deadbeef in 2026 for gap route-edit");
  });
});

describe("the content check: a synthesised search query must share a content word with the dispatch's goal", () => {
  test("[MUST-FAIL] the Spain query on the 'What is this about' goal is flagged, counted and logged", async () => {
    const { observeOffGoalContent, offGoalContentTally } = await fr();
    const before = offGoalContentTally.flagged;
    const log: string[] = [];
    expect(observeOffGoalContent("walk(test): webSearchResult query", ABOUT, SPAIN, (l) => log.push(l))).toBe(true);
    expect(offGoalContentTally.flagged).toBe(before + 1);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("OFF-GOAL CONTENT");
    expect(log[0]).toContain("observed, not blocked");
  });

  test("[CONTROL] an on-topic query is not flagged", async () => {
    const { observeOffGoalContent, offGoalContentTally } = await fr();
    const before = offGoalContentTally.flagged;
    const log: string[] = [];
    expect(observeOffGoalContent("walk(test): webSearchResult query", SPAIN, "current weather Spain Madrid", (l) => log.push(l))).toBe(false);
    expect(offGoalContentTally.flagged).toBe(before);
    expect(log).toHaveLength(0);
  });

  test("[WIRING] the walk's search resolve and the floor's search call both run the check", () => {
    expect(INDEX).toContain('if (/web_?search/i.test(shape) && typeof pointer.query === "string") observeOffGoalContent(`walk(${opts.surface}): ${shape} query`, dispatchContext.getStore()?.goal ?? goal, pointer.query, tap);');
    expect(INDEX).toContain('if (_dg && /web_?search/i.test(nm) && typeof a.query === "string") observeOffGoalContent(`floor: ${nm} query`, _dg, a.query, (m) => console.log(m));');
    expect(INDEX).toContain("dispatchContext.enterWith({ ...dispatchContext.getStore(), dispatchId: opts.variables.dispatch_id, ...(opts.learningMode ? { learningMode: opts.learningMode } : {}), ...(goal ? { goal } : {}) });");
    expect(INDEX).toContain("...(_floorMode ? { learningMode: _floorMode } : {}), goal }, () => universalToolFallback(goal, targetShapes, dispatchId, out, walkContext));");
  });
});
