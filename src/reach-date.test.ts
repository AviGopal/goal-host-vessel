// The asserted-date oracle (reach-date.ts): fixtures from output-shapes track 4 (F1, F2, F3) plus a
// positive control and the evidence-exclusion control. `now` is pinned so the fixtures are stable.
import { describe, expect, test } from "bun:test";
import { verifyAssertedDate, assertedDates, timeRelativeOffset, temporalGroundingBlock } from "./reach-date";

const NOW = new Date("2026-10-02T08:00:00Z");
const NEWS = "What is happening today? This should search the web and report with the main headlines and some commentary on each.";
const search = `- webSearchResult: ${JSON.stringify({ results: [{ title: "Iran war live", url: "https://www.aljazeera.com/news/liveblog/2026/10/1/iran-war-live", snippet: "October 1, 2026 — as of October 27, 2023 archive" }] })}`;

describe("verifyAssertedDate — must-fail fixtures", () => {
  test("F2: 'Today is October 27, 2023', no search → deterministic not-reached (the false reach #44)", () => {
    const v = verifyAssertedDate(NEWS, `- llm_completion: Today is October 27, 2023. Here are the main headlines: ...`, NOW);
    expect(v?.reached).toBe(false);
    expect(v?.deterministic).toBe(true);
    expect(v?.reason).toMatch(/^deterministic:stale-asserted-date/);
    expect(v?.reason).toContain("2026-10-02");
  });
  test("F1: 'as of June 7, 2024' WITH the run's 2026-dated search in the pool → still not-reached", () => {
    const v = verifyAssertedDate(NEWS, `${search}\n- llm_completion: ${JSON.stringify({ content: "Top stories as of June 7, 2024:\n1. ..." })}`, NOW);
    expect(v?.reached).toBe(false);
  });
  test("#51: 'as of mid-2024' (year granularity) → not-reached", () => {
    expect(verifyAssertedDate(NEWS, `- llm_completion: As of mid-2024, the main developments are ...`, NOW)?.reached).toBe(false);
  });
  test("yesterday offset: a report dated today for a 'yesterday' goal is within ±1 day; two days back is not", () => {
    const g = "What happened yesterday? Search the web and report.";
    expect(verifyAssertedDate(g, `- llm_completion: News for October 1, 2026: ...`, NOW)).toBeNull();
    expect(verifyAssertedDate(g, `- llm_completion: News for September 28, 2026: ...`, NOW)?.reached).toBe(false);
  });
});

describe("verifyAssertedDate — abstains", () => {
  test("positive control: a correctly dated deliverable abstains (a right date proves nothing else)", () => {
    expect(verifyAssertedDate(NEWS, `- llm_completion: Today is Friday, October 2, 2026. Headlines: ...`, NOW)).toBeNull();
    expect(verifyAssertedDate(NEWS, `- llm_completion: Report date: 2026-10-01 ...`, NOW)).toBeNull();
  });
  test("F3: invented headlines under the correct date abstain — the date check cannot catch it (G1's job)", () => {
    expect(verifyAssertedDate(NEWS, `- llm_completion: Today is Thursday, October 1, 2026. 1. Invented headline ...`, NOW)).toBeNull();
  });
  test("evidence dates never count: a stale date inside a search result does not condemn the deliverable", () => {
    expect(assertedDates(search)).toEqual([]);
    expect(verifyAssertedDate(NEWS, search, NOW)).toBeNull();
  });
  test("non-time-relative goals abstain even when the output carries an old date", () => {
    expect(timeRelativeOffset("Summarize the 2023 design doc")).toBeNull();
    expect(verifyAssertedDate("Summarize the 2023 design doc", `- llm_completion: As of October 2023 the design ...`, NOW)).toBeNull();
  });
  test("an intermediate's own dates are data, not a claim about today (shellResult / gap rows)", () => {
    const g = "Which gaps were opened today? Report them.";
    expect(verifyAssertedDate(g, `- shellResult: last updated 2026-09-15; as of September 15, 2026 the store held 12 rows\n- llm_completion: As of October 2, 2026 there are 12 open gaps.`, NOW)).toBeNull();
  });
  test("undated deliverable abstains", () => {
    expect(verifyAssertedDate(NEWS, `- llm_completion: Headlines: markets fell; a storm hit the coast.`, NOW)).toBeNull();
  });
});

test("temporalGroundingBlock is the 07-11 block, carrying the clock date", () => {
  const b = temporalGroundingBlock(NOW);
  expect(b).toStartWith("CURRENT DATE/TIME (authoritative, from the substrate host clock): 2026-10-02T08:00:00.000Z (today's date: 2026-10-02).");
});

describe("qa false-positive probe (qa5/fp.ts): realistic answers abstain", () => {
  const cases: Array<[string, string]> = [
    ["What is the current population of France?", "- llm_completion: As of 2024, France's population is about 68.4 million (INSEE)."],
    ["What is the latest TypeScript version?", "- llm_completion: As of March 2026, the latest stable release is TypeScript 6.0."],
    ["What is happening today? Search the web and report headlines.", "- llm_completion: Today is Friday, October 2, 2026.\n1. Fed holds rates (published date: September 29, 2026)"],
    ["What is happening today? Search the web and report headlines.", "- llm_completion: Headlines for Oct 2, 2026:\n1. Storm update — as of September 30, 2026 the death toll was 12"],
    ["Report the current server time", "- llm_completion: As of 2000 UTC the server is up."],
    ["Explain how the walk currently handles retries", "- llm_completion: The retry path, as of 2025, was added in commit abc."],
    ["What's the latest on the Iran war today?", "- llm_completion: The conflict began as of June 2025 and today it continues."],
  ];
  for (const [g, d] of cases) test(`abstains: ${g.slice(0, 40)} | ${d.slice(18, 60)}`, () => { expect(verifyAssertedDate(g, d, NOW)).toBeNull(); });
  test("the floor's unlabelled digest (answer + tool outputs) abstains: a search result's date is not the answer's claim", () => {
    expect(verifyAssertedDate(NEWS, "Today is October 2, 2026. Results:\nTOOL web_search => as of October 27, 2023 archive; Today is June 1, 2024", NOW)).toBeNull();
  });
});
