// THE VERBATIM ORACLE TAKES PRECEDENCE OVER THE LLM JUDGE, THROUGH THE REAL GATE.
//
// The unit tests in src/verbatim-read.test.ts pin the verdicts. This file pins the WIRING: inside
// verifyGoalReached, an in-family deterministic verdict is RETURNED as the oracle's, whatever the
// judge says (so FEEDBACK-RETRY, satisfier suppression and the widened retry — all keyed on
// walk.reached === false — cannot fire on a confirmed read). For the first N such verdicts the judge
// is still consulted in SHADOW; it answers HOLLOW here, so the test proves the shadow verdict is
// recorded as a disagreement label and never used. An out-of-family goal reaches the judge as before.
//
// NO LIVE SERVICES. globalThis.fetch is replaced BEFORE index.ts is imported (its bootstrap starts
// timers that call out) and every request is answered by the stub below: discovery names a fake
// fileContent vessel, that vessel serves the file, the judge prompt is recorded and answered
// HOLLOW, and anything else gets a 404.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const PATH = "/workspace/validation/latency-probe.txt";
const BYTES = "latency-probe-c951b44f4a99-42\n";
const FILE_VESSEL = "http://file-vessel.test.invalid/resolve";
const LLM_VESSEL = "http://llm-vessel.test.invalid/resolve";
const JUDGE_MARK = "You verify whether a substrate execution REACHED";

const realFetch = globalThis.fetch;
let judgeCalls = 0;
let rereads = 0;
const labelWrites: string[] = [];

function stubFetch(input: unknown, init?: { body?: unknown }): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? input);
  const body = typeof init?.body === "string" ? init.body : "";
  const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } }));
  if (body.includes(JUDGE_MARK)) {
    judgeCalls++;
    const verdict = JSON.stringify({ reached: false, reason: "stub judge: the output is truncated", completion_shapes: [] });
    return json({ content: { body: { content: verdict } }, body: { content: verdict } });
  }
  if (body.includes('"goal_verification_label_write"')) {
    labelWrites.push(body);
    return json({ ok: true });
  }
  if (url === FILE_VESSEL) {
    rereads++;
    return json({ shape: "fileContent", path: PATH, content: BYTES });
  }
  // The LLM router discovers an llm_completion producer WITH a vessel id, so a successful routed
  // call is buffered for reward — that is what makes the reward-buffer assertions non-vacuous.
  if (body.includes('"vesselCapability"') && body.includes('"llm_completion"')) {
    return json({ content: { vessels: [{ id: "llm-test-vessel", endpoint: "http://llm-vessel.test.invalid", resolve_endpoint: LLM_VESSEL, protocol: "http" }] } });
  }
  if (body.includes('"vesselCapability"') && body.includes('"fileContent"')) {
    return json({ content: { vessels: [{ id: "file-vessel", endpoint: "http://file-vessel.test.invalid", resolve_endpoint: FILE_VESSEL, protocol: "http" }] } });
  }
  return json({ error: "stub: not served" }, 404);
}

let rewardBufferEntries: (key?: string) => number;
let goalHashOf: (goal: string) => string;
let verifyGoalReached: (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string) => Promise<{ reached: boolean; reason: string } | null>;

// The shadow budget is a shaped policy read from $WORKSPACE_ROOT/policies. Point it at a temp
// workspace with shadow_n=1 and a far shadow_until (date-independent), so the first in-family
// verdict is shadowed and the second is not.
const prevRoot = process.env["WORKSPACE_ROOT"];
const tmpRoot = `${require("node:os").tmpdir()}/verbatim-gate-${process.pid}`;

const settle = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); };

beforeAll(async () => {
  const fs = require("node:fs");
  fs.mkdirSync(`${tmpRoot}/policies`, { recursive: true });
  fs.writeFileSync(`${tmpRoot}/policies/verbatimReadShadowPolicy.json`, JSON.stringify({ shadow_n: 1, shadow_until: "2099-01-01T00:00:00Z" }));
  process.env["WORKSPACE_ROOT"] = tmpRoot;
  globalThis.fetch = stubFetch as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  const mod = await import("../src/index");
  ({ rewardBufferEntries } = await import("../src/llm-router"));
  ({ goalHashOf } = await import("../src/goal-target-inference"));
  verifyGoalReached = mod.verifyGoalReached as unknown as typeof verifyGoalReached;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevRoot;
  try { require("node:fs").rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp dir */ }
});

const digestWith = (goal: string, content: string) => [
  `- goal: ${JSON.stringify({ goal })}`,
  `- dispatch_id: ee3cdfc3-a003-4556-8363-d81037550549`,
  `- fileContent: ${JSON.stringify({ shape: "fileContent", path: PATH, content })}`,
].join("\n");

const answerDigest = (goal: string, read: string, answer: string) => `${digestWith(goal, read)}\n- llmTextCompletion: ${answer}`;

describe("verifyGoalReached: verbatim oracle precedence", () => {
  test("in-family + exact content → reached; the HOLLOW shadow judge is recorded as a disagreement, never used", async () => {
    const goal = `Read ${PATH} and tell me exactly what it says.`;
    judgeCalls = 0; rereads = 0; labelWrites.length = 0;
    const bufferedBefore = rewardBufferEntries();
    const v = await verifyGoalReached(goal, ["goal", "dispatch_id", "fileContent"], "walk(1 steps): satisfier:fileContent", digestWith(goal, BYTES));
    expect(v?.reached).toBe(true);
    expect(v?.reason).toMatch(/^deterministic:verified-verbatim-read/);
    expect(rereads).toBe(1);
    // The shadow is fire-and-forget: the verdict came back first; the judge and the label follow.
    await settle(() => labelWrites.length > 0);
    expect(judgeCalls).toBe(1);
    expect(labelWrites.length).toBe(1);
    // NOT ground truth: the schema's non-binary verdict, labelled automated, its own source.
    expect(labelWrites[0]).toContain("disputed: oracle=reached judge=hollow");
    expect(labelWrites[0]).toContain('"verdict":"partial"');
    expect(labelWrites[0]).toContain('"labeler":"automated"');
    expect(labelWrites[0]).toContain('"source":"verbatim-shadow-disagreement"');
    expect(labelWrites[0]).toContain('"execution_id":"verbatim-shadow:');
    // REWARD: the shadow judge call added nothing to ANY dispatch's reward buffer.
    expect(rewardBufferEntries()).toBe(bufferedBefore);
    expect(rewardBufferEntries(goalHashOf(goal))).toBe(0);
  });

  test("past the shadow budget (shadow_n=1): a planted answer → deterministic FAIL, and the judge is NOT called", async () => {
    // A different goal (a different dispatch key), so this is the budget at work, not the dedupe.
    const goal = `Print the exact contents of ${PATH}.`;
    judgeCalls = 0; labelWrites.length = 0;
    const v = await verifyGoalReached(goal, ["goal", "dispatch_id", "fileContent", "llmTextCompletion"], "walk(2 steps)", answerDigest(goal, BYTES, "latency-probe-PLANTED"));
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^deterministic:verbatim-read-/);
    await new Promise((r) => setTimeout(r, 100));
    expect(judgeCalls).toBe(0);
    expect(labelWrites.length).toBe(0);
  });

  test("out-of-family goal → abstains, and the judge decides as before", async () => {
    const goal = `Read ${PATH} and summarize it in one sentence.`;
    judgeCalls = 0; rereads = 0;
    const before = rewardBufferEntries(goalHashOf(goal));
    const v = await verifyGoalReached(goal, ["goal", "dispatch_id", "fileContent"], "walk(1 steps): satisfier:fileContent", digestWith(goal, BYTES));
    expect(rereads).toBe(0);
    expect(judgeCalls).toBeGreaterThan(0);
    expect(v?.reason).toBe("stub judge: the output is truncated");
    // POSITIVE CONTROL for the reward assertion above: the same judge, routed the ordinary way,
    // DOES land in this goal's reward buffer — so "0 entries" for the shadow is not an artefact.
    expect(rewardBufferEntries(goalHashOf(goal))).toBe(before + 1);
  }, 20_000);
});
