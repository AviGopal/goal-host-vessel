// G1, the grounded-report oracle (grounded-report.ts). Positive control: fb068805's own pool (dispatch
// fb068805, goal a30a893c, 2026-10-02) — a dated report whose llm_completion CONSUMED the run's
// web_search by edge, rejected by the LLM judge. Captured as previews (see the fixture's _provenance).
// AS RECORDED the run ABSTAINS: the walk also produced a placeholder llm_completion_result (the
// write_note bridge's "[Insert Current Date]" template), and G1 does not grade around what else the
// person may be shown. The positive control is that pool WITHOUT the placeholder sibling.
// Must-fail controls: each is an ABSTAIN (null), so the judge still grades it.
import { describe, expect, test } from "bun:test";
import { verifyGroundedReport, groundedReportPolicyFrom, GROUNDED_REPORT_DEFAULTS, itemBlocks, headlineOf, normText, searchResultsOf, poolEvidenceOf, type PoolEvidence } from "./grounded-report";

const FX = require("../test/fixtures/grounded-report-fb068805.json") as { goal: string; clock: string; pool: PoolEvidence[] };
const NOW = new Date(FX.clock);
const REPORT_ID = "walk-zwkhz6-0k0yikb-llm_completion-152";
const report = (): string => (FX.pool.find((p) => p.id === REPORT_ID)!.content as { content: string }).content;
/** fb068805's pool without the placeholder sibling: the positive control. */
const CLEAN = FX.pool.filter((p) => p.shape !== "llm_completion_result");
const SURFACED = ["web_search", "llm_completion", "obsidian:write_note"]; // attempt 3's targets
/** The clean pool with the report's text replaced (edges unchanged). */
const withReport = (text: string, edges?: string[]): PoolEvidence[] => CLEAN.map((p) => p.id === REPORT_ID
  ? { ...p, content: { resolved: true, shape: "llmCompletion", content: text }, ...(edges ? { consumedIds: edges } : {}) }
  : p);
const run = (pool: PoolEvidence[], goal = FX.goal, now = NOW, policy = GROUNDED_REPORT_DEFAULTS, surfaced: string[] = SURFACED) => {
  const why: string[] = [];
  const v = verifyGroundedReport({ goal, pool, now, policy, surfaced, onAbstain: (w) => why.push(w) });
  return { v, why: why.join(" | ") };
};

describe("positive control: fb068805, the report the judge rejected", () => {
  test("REACHED, deterministic, naming the consumed search, the clock date and both hosts", () => {
    const { v, why } = run(CLEAN);
    expect(why).toBe("");
    expect(v?.reached).toBe(true);
    expect(v?.deterministic).toBe(true);
    expect(v?.completion_shapes).toEqual(["llm_completion"]);
    expect(v?.reason).toMatch(/^deterministic:grounded-report — /);
    expect(v?.reason).toContain("walk-zwkhz6-0k0yikb-web_search-151");
    expect(v?.reason).toContain('"October 2, 2026"');
    expect(v?.reason).toContain("2026-10-02");
    expect(v?.reason).toContain("aljazeera.com, theguardian.com");
  });
  test("the report's headlines match the consumed result titles through the normaliser (no URL is cited)", () => {
    const results = searchResultsOf(FX.pool.find((p) => p.shape === "web_search")!.content);
    expect(report()).not.toMatch(/https?:\/\//);
    const blocks = itemBlocks(report());
    expect(blocks).toHaveLength(2);
    expect(normText(blocks[0]!)).toContain(normText(headlineOf(results[0]!.title)));
    expect(normText(blocks[1]!)).toContain(normText(headlineOf(results[1]!.title)));
  });
  test("AS RECORDED (with the placeholder sibling the walk also produced) it ABSTAINS", () => {
    expect(FX.pool.find((p) => p.shape === "llm_completion_result")!.content).toContain("[Insert Current Date]");
    const { v, why } = run(FX.pool);
    expect(v).toBeNull();
    expect(why).toContain("another answer-shape impulse (llm_completion_result) carries a template placeholder");
  });
  test("an answer shape the walk does not surface is not graded", () => {
    const { v, why } = run(CLEAN, FX.goal, NOW, GROUNDED_REPORT_DEFAULTS, ["memoryNote_write"]);
    expect(v).toBeNull();
    expect(why).toContain("no surfaced answer shape");
    expect(run(CLEAN, FX.goal, NOW, GROUNDED_REPORT_DEFAULTS, []).v).toBeNull();
  });
  test("the same report is reached the day after (±1 day) and for a 'yesterday' goal asked the day after", () => {
    expect(run(CLEAN, FX.goal, new Date("2026-10-03T09:00:00Z")).v?.reached).toBe(true);
    expect(run(CLEAN, FX.goal.replace("today", "yesterday"), new Date("2026-10-03T12:00:00Z")).v?.reached).toBe(true);
  });
  test("a search payload carried as a JSON string grounds the same way", () => {
    const pool = CLEAN.map((p) => p.shape === "web_search" ? { ...p, content: JSON.stringify(p.content) } : p);
    expect(run(pool).v?.reached).toBe(true);
  });
});

describe("must-fail controls: each ABSTAINS (the judge grades it), none is reached", () => {
  test("undated: the same report with its date line removed", () => {
    const { v, why } = run(withReport(report().replace("Here's a report on what's happening today, October 2, 2026:", "Here's a report:")));
    expect(v).toBeNull();
    expect(why).toContain("asserts no report date");
  });
  test("grounded but wrong date: 'today, October 27, 2023'", () => {
    const { v, why } = run(withReport(report().replace("October 2, 2026", "October 27, 2023")));
    expect(v).toBeNull();
    expect(why).toContain('"October 27, 2023"');
  });
  test("grounded but wrong date by the clock: the fb068805 report read on 2026-10-05", () => {
    expect(run(CLEAN, FX.goal, new Date("2026-10-05T09:00:00Z")).v).toBeNull();
  });
  test("cites sources not in any consumed search: headlines that are not the run's results", () => {
    const fake = report()
      .replace(/Iran war live: US moves 2,000 Marines to Middle East, tanker hit in Hormuz/g, "Global markets rally as central banks signal coordinated rate cuts")
      .replace(/400 French schools closed on Friday as protests escalate into ‘urban violence’/g, "Record heatwave grips southern Europe as wildfires spread across Greece");
    const { v, why } = run(withReport(fake));
    expect(v).toBeNull();
    expect(why).toMatch(/0 of 2 item\(s\) name a fresh consumed result/);
  });
  test("a planted URL (not in the consumed results) abstains even when the titles match", () => {
    const { v, why } = run(withReport(report().replace("(Al Jazeera), ", "(Al Jazeera, https://www.aljazeera.com/news/2026/10/2/invented-story), ")));
    expect(v).toBeNull();
    expect(why).toContain("absent from the consumed results");
  });
  test("a cited URL that IS a consumed result is accepted", () => {
    expect(run(withReport(report().replace("(Al Jazeera), ", "(https://www.aljazeera.com/news/liveblog/2026/10/2/iran-war-live-us-moves-2000-marines-to-middle-east-tanker-hit-in-hormuz), "))).v?.reached).toBe(true);
  });
  test("template placeholders: '[Headline 1]' and '{{current_date}}'", () => {
    expect(run(withReport(report() + "\n\n3. [Headline 1]\n- Commentary: [Your thoughts]")).why).toContain("placeholder");
    expect(run(withReport(report() + "\n\n3. [Headline 1]")).v).toBeNull();
    expect(run(withReport(report().replace("October 2, 2026", "{{current_date}}"))).v).toBeNull();
  });
  test("grounded by TEXT only: the same report with no edge to the search is not grounded", () => {
    const { v, why } = run(withReport(report(), []));
    expect(v).toBeNull();
    expect(why).toContain("consumed a search result (no edge to evidence)");
  });
  test("an edge to a non-search impulse (web_resource only) is not grounding", () => {
    expect(run(withReport(report(), ["walk-zwkhz6-0k0yikb-web_resource-142"])).v).toBeNull();
  });
  test("one grounded item is not a report of headlines (N=2)", () => {
    const one = report().split("\n**2.")[0]!;
    const { v, why } = run(withReport(one));
    expect(v).toBeNull();
    expect(why).toMatch(/1 of 1 item/);
  });
  test("headlines with no commentary of their own (bare title lines) abstain", () => {
    const bare = "Here's a report on what's happening today, October 2, 2026:\n1. Iran war live: US moves 2,000 Marines to Middle East, tanker hit in Hormuz (Al Jazeera)\n2. 400 French schools closed on Friday as protests escalate into ‘urban violence’ (The Guardian)";
    expect(run(withReport(bare)).v).toBeNull();
  });
  test("'multiple sources' needs ≥2 hosts: both grounded items on one host abstain", () => {
    // The Guardian result re-hosted under the Al Jazeera domain: same items, one host.
    const pool = CLEAN.map((p) => p.shape !== "web_search" ? p : { ...p, content: { ...(p.content as object), results: (p.content as { results: Array<{ url: string }> }).results.map((r) => ({ ...r, url: r.url.replace("www.theguardian.com", "www.aljazeera.com") })) } });
    const { v, why } = run(pool);
    expect(v).toBeNull();
    expect(why).toMatch(/span 1 host\(s\); 2 required/);
  });
});

describe("family and policy", () => {
  test("out of family (not time-relative, or not a report) is a silent abstain", () => {
    const a = run(CLEAN, "Produce a report with the main headlines about the Iran war.");
    expect(a.v).toBeNull(); expect(a.why).toBe("");
    const b = run(CLEAN, "What is the weather today in Paris?");
    expect(b.v).toBeNull(); expect(b.why).toBe("");
  });
  test("groundedReportPolicy is read field by field; no document = OBSERVE (enabled false)", () => {
    expect(groundedReportPolicyFrom(null)).toEqual(GROUNDED_REPORT_DEFAULTS);
    expect(GROUNDED_REPORT_DEFAULTS.enabled).toBe(false);
    expect(groundedReportPolicyFrom({ min_items: 3, min_item_words: "x", enabled: "yes" })).toEqual({ ...GROUNDED_REPORT_DEFAULTS, min_items: 3 });
    expect(groundedReportPolicyFrom({ enabled: true }).enabled).toBe(true);
    expect(groundedReportPolicyFrom({ generic_terms: ["Technology"] }).generic_terms).toEqual(["technology"]);
  });
  test("a stricter policy turns the positive control into an abstain", () => {
    expect(run(CLEAN, FX.goal, NOW, groundedReportPolicyFrom({ min_items: 3 })).v).toBeNull();
    expect(run(CLEAN, FX.goal, NOW, groundedReportPolicyFrom({ min_item_words: 400 })).v).toBeNull();
    expect(run(CLEAN, FX.goal, NOW, groundedReportPolicyFrom({ min_item_overlap: 200 })).v).toBeNull();
  });
  test("poolEvidenceOf carries the walk's ids, shapes and consumedIds edges", () => {
    expect(poolEvidenceOf([{ id: "a", content: 1, metadata: { shape: "llm_completion", consumedIds: ["b"] } }, { id: "b", content: 2 }]))
      .toEqual([{ id: "a", shape: "llm_completion", content: 1, consumedIds: ["b"] }, { id: "b", shape: "", content: 2 }]);
  });
});
