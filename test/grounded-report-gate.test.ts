// G1 THROUGH THE REAL GATE. The stub judge rejects, as the real one rejected fb068805 ("lacks the
// required commentary and report structure").
//   OBSERVE (no policy, the default): the judge's verdict stands; G1's reach is recorded beside it as
//     an automated "grounded-report-observe" label carrying agree=false.
//   DECIDE (groundedReportPolicy enabled:true): the walk's untruncated pool (with its V4 edges) is read
//     first and the verdict is a deterministic reach — HOLLOW on the parent sha.
// Every must-fail control falls through to the judge (or, for a stale date, the asserted-date oracle).
//
// NO LIVE SERVICES: fetch is stubbed before index.ts is imported (as reach-date-gate does). The
// oracle reads the host clock, so the fixture's date line is rewritten to today's date.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const JUDGE_MARK = "You verify whether a substrate execution REACHED";
const LLM_VESSEL = "http://llm-vessel.test.invalid/resolve";
const realFetch = globalThis.fetch;
let judgeCalls = 0;
const labels: string[] = [];
function stubFetch(_input: unknown, init?: { body?: unknown }): Promise<Response> {
  const body = typeof init?.body === "string" ? init.body : "";
  const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } }));
  if (body.includes(JUDGE_MARK)) {
    judgeCalls++;
    const verdict = JSON.stringify({ reached: false, reason: "stub judge: The output contains headlines but lacks the required commentary and report structure.", completion_shapes: ["web_search"] });
    return json({ content: { body: { content: verdict } }, body: { content: verdict } });
  }
  if (body.includes('"goal_verification_label_write"')) { labels.push(body); return json({ ok: true }); }
  if (body.includes('"vesselCapability"') && body.includes('"llm_completion"')) {
    return json({ content: { vessels: [{ id: "llm-test-vessel", endpoint: "http://llm-vessel.test.invalid", resolve_endpoint: LLM_VESSEL, protocol: "http" }] } });
  }
  return json({ error: "stub: not served" }, 404);
}

type Pool = Array<{ id: string; shape: string; content: unknown; consumedIds?: string[] }>;
type V = { reached: boolean; reason: string; deterministic?: boolean; completion_shapes?: string[] } | null;
let verifyGoalReached: (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string, commandEvidence?: string, walkEvidence?: unknown, judgeView?: unknown, deliverables?: string[], poolEvidence?: Pool) => Promise<V>;
const prevRoot = process.env["WORKSPACE_ROOT"];
const tmpRoot = `${require("node:os").tmpdir()}/grounded-report-gate-${process.pid}`;
const POLICY = `${tmpRoot}/policies/groundedReportPolicy.json`;
const setPolicy = (p: unknown) => require("node:fs").writeFileSync(POLICY, JSON.stringify(p));

beforeAll(async () => {
  require("node:fs").mkdirSync(`${tmpRoot}/policies`, { recursive: true });
  setPolicy({ enabled: true }); // DECIDE for the chain tests; no shadow_n ⇒ no shadow judge calls
  process.env["WORKSPACE_ROOT"] = tmpRoot;
  globalThis.fetch = stubFetch as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  verifyGoalReached = (await import("../src/index")).verifyGoalReached as unknown as typeof verifyGoalReached;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevRoot;
  try { require("node:fs").rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp dir */ }
});

const FX = require("./fixtures/grounded-report-fb068805.json") as { goal: string; pool: Pool };
const REPORT_ID = "walk-zwkhz6-0k0yikb-llm_completion-152";
const TODAY = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const reportText = (): string => (FX.pool.find((p) => p.id === REPORT_ID)!.content as { content: string }).content.replace("October 2, 2026", TODAY);
const CLEAN = FX.pool.filter((p) => p.shape !== "llm_completion_result"); // see grounded-report.test.ts
const poolWith = (text: string, edges?: string[]): Pool => CLEAN.map((p) => p.id === REPORT_ID
  ? { ...p, content: { resolved: true, shape: "llmCompletion", content: text }, ...(edges ? { consumedIds: edges } : {}) } : p);
const SHAPES = ["goal", "dispatch_id", "web_resource", "web_search", "llm_completion", "llm_completion_result"];
const gate = (pool: Pool | undefined, text = reportText()) =>
  verifyGoalReached(FX.goal, SHAPES, "walk(4 steps): satisfier:web_search → satisfier:llm_completion", `- llm_completion: ${text}`, undefined, undefined, { deliverableCut: false, cuts: [] }, ["web_search", "llm_completion", "obsidian:write_note"], pool);

describe("verifyGoalReached: the grounded-report oracle precedes the judge", () => {
  test("fb068805 (positive control, must be HOLLOW on the parent): a deterministic reach, the judge not consulted", async () => {
    judgeCalls = 0;
    const v = await gate(poolWith(reportText()));
    expect(v?.reached).toBe(true);
    expect(v?.deterministic).toBe(true);
    expect(v?.reason).toMatch(/^deterministic:grounded-report — /);
    expect(v?.completion_shapes).toEqual(["llm_completion"]);
    expect(judgeCalls).toBe(0);
  });
  test("no pool evidence (the engine path, the floor): the judge grades as before", async () => {
    judgeCalls = 0;
    const v = await gate(undefined);
    expect(judgeCalls).toBeGreaterThan(0);
    expect(v?.reached).toBe(false);
  }, 20_000);
  test("OBSERVE is the default: with no policy document the judge decides, and G1's reach is recorded as a disagreement label", async () => {
    require("node:fs").rmSync(POLICY, { force: true });
    try {
      judgeCalls = 0; labels.length = 0;
      const v = await gate(poolWith(reportText()));
      expect(judgeCalls).toBeGreaterThan(0);
      expect(v?.reached).toBe(false);
      expect(v?.deterministic).not.toBe(true); // no α credit, no mint on an observed G1 reach
      await new Promise((r) => setTimeout(r, 20));
      const obs = labels.filter((l) => l.includes('"grounded-report-observe"'));
      expect(obs).toHaveLength(1);
      expect(obs[0]).toContain("agree=false oracle=reached judge=hollow");
    } finally { setPolicy({ enabled: true }); }
  }, 20_000);
  test("enabled must be exactly true: enabled:\"yes\" observes", async () => {
    setPolicy({ enabled: "yes" });
    try {
      judgeCalls = 0;
      const v = await gate(poolWith(reportText()));
      expect(judgeCalls).toBeGreaterThan(0);
      expect(v?.reached).toBe(false);
    } finally { setPolicy({ enabled: true }); }
  }, 20_000);
});

describe("must-fail controls through the gate: never reached by the oracle", () => {
  const judged = async (pool: Pool, text?: string) => { judgeCalls = 0; const v = await gate(pool, text); return { v, calls: judgeCalls }; };
  test("undated report → the judge", async () => {
    const t = reportText().replace(`Here's a report on what's happening today, ${TODAY}:`, "Here's a report:");
    const { v, calls } = await judged(poolWith(t), t);
    expect(calls).toBeGreaterThan(0); expect(v?.reached).toBe(false);
  }, 20_000);
  test("sources not in any consumed search → the judge", async () => {
    const t = reportText().replace(/Iran war live: US moves 2,000 Marines to Middle East, tanker hit in Hormuz/g, "Global markets rally as central banks signal coordinated rate cuts")
      .replace(/400 French schools closed on Friday as protests escalate into ‘urban violence’/g, "Record heatwave grips southern Europe as wildfires spread across Greece");
    const { v, calls } = await judged(poolWith(t), t);
    expect(calls).toBeGreaterThan(0); expect(v?.reached).toBe(false);
  }, 20_000);
  test("template placeholders ('[Headline 1]', '{{current_date}}') → the judge", async () => {
    for (const t of [reportText() + "\n\n3. [Headline 1]\n- Commentary: [Your thoughts]", reportText().replace(TODAY, "{{current_date}}")]) {
      const { v, calls } = await judged(poolWith(t), t);
      expect(calls).toBeGreaterThan(0); expect(v?.reached).toBe(false);
    }
  }, 40_000);
  test("grounded but wrong date → the asserted-date oracle's deterministic not-reached", async () => {
    const t = reportText().replace(TODAY, "October 27, 2023");
    const { v, calls } = await judged(poolWith(t), t);
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^deterministic:stale-asserted-date/);
    expect(calls).toBe(0);
  });
  test("the report with no edge to the search → the judge", async () => {
    const { v, calls } = await judged(poolWith(reportText(), []));
    expect(calls).toBeGreaterThan(0); expect(v?.reached).toBe(false);
  }, 20_000);
});

describe("source wiring", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
  test("the oracle sits after the asserted-date oracle and before the remaining chain", () => {
    const d = src.indexOf("const dateV = verifyAssertedDate(goal, dig);");
    const g = src.indexOf("const groundedV = verifyGroundedReport({");
    const n = src.indexOf("INDEPENDENT AGGREGATE ORACLE");
    expect(d).toBeGreaterThan(0); expect(g).toBeGreaterThan(d); expect(n).toBeGreaterThan(g);
  });
  test("its thresholds are the shaped groundedReportPolicy (law 1), not an env var", () => {
    const g = src.indexOf("const groundedV = verifyGroundedReport({");
    expect(src.slice(g - 200, g)).toContain('resolveShapedPolicy("groundedReportPolicy")');
    expect(src).not.toMatch(/process\.env\[?["'.]?GROUNDED/);
  });
  test("only the two END-OF-WALK reach calls pass the pool; the interim check cannot end a walk on G1", () => {
    expect(src.match(/poolEvidenceOf\(poolImpulses\)/g) ?? []).toHaveLength(2);
    const i = src.indexOf("const interim = await verifyGoalReached(");
    expect(src.slice(i, i + 500)).not.toContain("poolEvidenceOf");
  });
  test("G1 grades only the shapes the walk surfaces (its deliverables reach the oracle)", () => {
    expect(src).toContain("goal, pool: poolEvidence, surfaced: deliverables ?? [], policy,");
  });
  test("observe vs decide is the policy switch; no hard-coded shadow window", () => {
    expect(src).toContain("if (groundedV && !policy.enabled) {");
    expect(src).not.toMatch(/2026-10-10/);
    expect(src).toContain('recordGroundedComparison(goal, key, groundedObserved, judged, "grounded-report-observe")');
  });
  test("in DECIDE the judge runs in bounded shadow through the verbatim mechanism, never as control", () => {
    expect(src).toContain('createVerbatimShadow("grounded-report-oracle")');
    expect(src).toContain("void groundedReportShadow.run(groundedV,");
  });
});
