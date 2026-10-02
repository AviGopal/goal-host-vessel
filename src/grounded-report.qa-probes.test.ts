// qa11's adversarial probes for G1 (/home/avi/.claude/jobs/ac8b0aad/tmp/qa11/ab/src/qa-probe.test.ts),
// kept as MUST-FAIL controls. On the first build every probe below was REACHED. Each now abstains, and
// each asserts the rule that catches it, so a probe cannot pass for an unrelated reason. Probes run on
// fb068805's pool WITHOUT its placeholder sibling (which alone abstains the run: P5), so the targeted
// rule — not the sibling rule — is what each one exercises.
import { describe, expect, test } from "bun:test";
import { verifyGroundedReport, GROUNDED_REPORT_DEFAULTS, type PoolEvidence } from "./grounded-report";

const FX = require("../test/fixtures/grounded-report-fb068805.json") as { goal: string; clock: string; pool: PoolEvidence[] };
const NOW = new Date(FX.clock);
const RID = "walk-zwkhz6-0k0yikb-llm_completion-152";
const SID = "walk-zwkhz6-0k0yikb-web_search-151";
const T1 = "Iran war live: US moves 2,000 Marines to Middle East, tanker hit in Hormuz";
const T2 = "400 French schools closed on Friday as protests escalate into ‘urban violence’";
const SURFACED = ["web_search", "llm_completion", "obsidian:write_note"];
const CLEAN = FX.pool.filter((p) => p.shape !== "llm_completion_result");
const REPORT = (FX.pool.find((p) => p.id === RID)!.content as { content: string }).content;
const withReport = (text: string, extra: PoolEvidence[] = [], base: PoolEvidence[] = CLEAN): PoolEvidence[] => [
  ...base.map((p) => p.id === RID ? { ...p, content: { resolved: true, content: text } } : p),
  ...extra,
];
const run = (pool: PoolEvidence[], goal = FX.goal, now = NOW) => {
  const why: string[] = [];
  const v = verifyGroundedReport({ goal, pool, now, surfaced: SURFACED, policy: GROUNDED_REPORT_DEFAULTS, onAbstain: (w) => why.push(w) });
  return { v, why: why.join(" | ") };
};
const HEAD = "Here's a report on what's happening today, October 2, 2026:\n\n";
const pad = " lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi";
const PASTA = " My favourite pasta recipe uses fresh basil, garlic, olive oil, parmesan and a pinch of salt; boil the water first, cook the spaghetti for nine minutes, then toss everything together and serve warm with bread and wine.";
const sn = (FX.pool.find((p) => p.id === SID)!.content as { results: Array<{ snippet: string }> }).results;

describe("qa11 probes: every one abstains, for its own reason", () => {
  test("P0 positive control (clean pool) is still REACHED", () => {
    expect(run(CLEAN).v?.reached).toBe(true);
  });
  test("P1 snippets pasted verbatim: commentary excludes the title AND its snippet (§4.1)", () => {
    const { v, why } = run(withReport(HEAD + `1. ${T1}\n${sn[0]!.snippet}\n\n2. ${T2}\n${sn[1]!.snippet}`));
    expect(v).toBeNull();
    expect(why).toMatch(/item 1: \d+ words beyond title and snippet/);
  });
  test("P2 real titles + lorem ipsum: commentary must be about its result", () => {
    const { v, why } = run(withReport(HEAD + `1. ${T1}.${pad}\n\n2. ${T2}.${pad}`));
    expect(v).toBeNull();
    expect(why).toContain("commentary shares 0 content word(s) with its result");
  });
  test("P2b real titles + a pasta recipe", () => {
    const { v, why } = run(withReport(HEAD + `1. ${T1}.${PASTA}\n\n2. ${T2}.${PASTA}`));
    expect(v).toBeNull();
    expect(why).toContain("commentary shares 0 content word(s) with its result");
  });
  test("P3 wrong subject: a technology goal answered with the run's world news", () => {
    const { v, why } = run(CLEAN, "Produce a report on today's technology headlines from multiple sources with commentary on each.");
    expect(v).toBeNull();
    expect(why).toContain("the goal names [technology]");
  });
  test("P3b wrong subject: a sports goal", () => {
    const { v, why } = run(CLEAN, "Give me today's sports news headlines with commentary.");
    expect(v).toBeNull();
    expect(why).toContain("the goal names [sports]");
  });
  test("P4 2019 results under today's date: a result dated outside the window cannot ground an item", () => {
    const stale = [
      { title: "Notre-Dame cathedral engulfed by fire as Paris watches in horror", url: "https://www.bbc.co.uk/news/world-europe-47941794", snippet: "2019-04-15" },
      { title: "Boris Johnson wins Conservative leadership race to become prime minister", url: "https://www.theguardian.com/politics/2019/jul/23/boris-johnson-wins", snippet: "2019-07-23" },
    ];
    const text = HEAD + `1. Notre-Dame cathedral engulfed by fire as Paris watches in horror (BBC). The blaze destroyed the spire and much of the roof of the medieval cathedral, with firefighters working through the night to save the bell towers and the priceless relics inside the building.\n\n2. Boris Johnson wins Conservative leadership race to become prime minister (Guardian). The former foreign secretary beat Jeremy Hunt by a wide margin among party members, promising to deliver Brexit by the end of October whatever happens in Parliament, and he named a new cabinet within hours of entering Downing Street that afternoon.`;
    const pool = CLEAN.map((p) => p.id === SID ? { ...p, content: { results: stale } } : p.id === RID ? { ...p, content: { resolved: true, content: text } } : p);
    const { v, why } = run(pool);
    expect(v).toBeNull();
    expect(why).toContain("item 1: its result is dated outside the window");
    expect(why).toContain("item 2: its result is dated outside the window");
  });
  test("P5 the run AS RECORDED: a later placeholder llm_completion_result abstains", () => {
    const { v, why } = run(FX.pool);
    expect(v).toBeNull();
    expect(why).toContain("carries a template placeholder");
  });
  test("P5b a later unedged 'I could not find any news' answer abstains", () => {
    const { v, why } = run(withReport(REPORT, [{ id: "x-goal_answer-999", shape: "goal_answer", content: "I could not find any news for today; please try again later." }]));
    expect(v).toBeNull();
    expect(why).toContain("a later answer (goal_answer) is not grounded");
  });
  test("P7 a calendar page counted as a headline, padded with lorem", () => {
    const { v } = run(withReport(HEAD + `1. ${T1}. ${pad}\n\n2. Happening Today: Holidays, events & news. ${pad}`));
    expect(v).toBeNull();
  });
  test("P9 an out-of-domain 'today' goal (failing tests in a vessel)", () => {
    const { v, why } = run(CLEAN, "Write a summary of today's failing tests in goal-host-vessel.");
    expect(v).toBeNull();
    expect(why).toMatch(/the goal names \[.*failing.*\]/);
  });
});
