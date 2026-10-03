// THE CLOCK REACHES THE JUDGE'S VERDICT, THROUGH THE REAL GATE (V2 of the vertical slice).
//
// Must-fail control F2 (output-shapes track 4): "Today is October 27, 2023" with no search was
// REACHED by the LLM judge (#44). Here the stub judge answers REACHED, as the real one did. On the
// parent sha verifyGoalReached returns the judge's reach; with the asserted-date oracle in the chain
// it returns a deterministic not-reached and never consults the judge. A correctly dated deliverable
// still reaches the judge (positive control), and the writer's prompt reads the same clock block.
//
// NO LIVE SERVICES: fetch is stubbed before index.ts is imported (as verbatim-read-gate does).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const JUDGE_MARK = "You verify whether a substrate execution REACHED";
const LLM_VESSEL = "http://llm-vessel.test.invalid/resolve";
const realFetch = globalThis.fetch;
let judgeCalls = 0;

function stubFetch(input: unknown, init?: { body?: unknown }): Promise<Response> {
  const body = typeof init?.body === "string" ? init.body : "";
  const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } }));
  if (body.includes(JUDGE_MARK)) {
    judgeCalls++;
    const verdict = JSON.stringify({ reached: true, reason: "stub judge: a coherent news report", completion_shapes: ["llm_completion"] });
    return json({ content: { body: { content: verdict } }, body: { content: verdict } });
  }
  if (body.includes('"goal_verification_label_write"')) return json({ ok: true });
  if (body.includes('"vesselCapability"') && body.includes('"llm_completion"')) {
    return json({ content: { vessels: [{ id: "llm-test-vessel", endpoint: "http://llm-vessel.test.invalid", resolve_endpoint: LLM_VESSEL, protocol: "http" }] } });
  }
  return json({ error: "stub: not served" }, 404);
}

let verifyGoalReached: (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string) => Promise<{ reached: boolean; reason: string; deterministic?: boolean } | null>;
const prevRoot = process.env["WORKSPACE_ROOT"];
const tmpRoot = `${require("node:os").tmpdir()}/reach-date-gate-${process.pid}`;

beforeAll(async () => {
  require("node:fs").mkdirSync(`${tmpRoot}/policies`, { recursive: true });
  process.env["WORKSPACE_ROOT"] = tmpRoot;
  globalThis.fetch = stubFetch as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  const mod = await import("../src/index");
  verifyGoalReached = mod.verifyGoalReached as unknown as typeof verifyGoalReached;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevRoot;
  try { require("node:fs").rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp dir */ }
});

const NEWS = "What is happening today? This should search the web and report with the main headlines and some commentary on each.";
const SHAPES = ["goal", "llm_completion"];

describe("verifyGoalReached: the asserted-date oracle precedes the judge", () => {
  test("F2 must-fail: a stale 'Today is October 27, 2023' is NOT reached, and the judge is not consulted", async () => {
    judgeCalls = 0;
    const v = await verifyGoalReached(NEWS, SHAPES, "walk(1 steps): satisfier:llm_completion", `- llm_completion: Today is October 27, 2023. Here are the main headlines: 1. ...`);
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^deterministic:stale-asserted-date/);
    expect(judgeCalls).toBe(0);
  });
  test("positive control: today's date abstains, and the judge decides as before", async () => {
    judgeCalls = 0;
    const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    // The chain carries a web_search: an UNSOURCED news answer is now refused before the judge by
    // reach-grounding.ts (unsourced-current-information), which is not what this control isolates.
    const v = await verifyGoalReached(NEWS, ["goal", "web_search", "llm_completion"], "walk(2 steps): web_search -> llm_completion", `- web_search: {"results":[{"title":"Main headline","url":"https://news.example.org/a"}]}\n- llm_completion: Today is ${today}. Here are the main headlines: 1. ...`);
    expect(judgeCalls).toBeGreaterThan(0);
    expect(v?.reached).toBe(true);
  }, 20_000);
});

describe("the writer reads the clock (source wiring)", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
  test("the llm_completion default prompt binds the shared host-clock block for time-relative goals", () => {
    const i = src.indexOf("const _poolFindings = boundFindingsFromIntermediates(");
    const block = src.slice(i, i + 3000);
    expect(block).toMatch(/timeRelativeOffset\(goal\) !== null \? temporalGroundingBlock\(\)/);
    expect(block).toMatch(/\$\{_clock\}\$\{_fbPreamble\}\$\{goal\}/);
  });
  test("one clock block: no inline copy of the 07-11 temporalGrounding text remains", () => {
    expect(src.match(/CURRENT DATE\/TIME \(authoritative/g) ?? []).toHaveLength(0);
  });
});
