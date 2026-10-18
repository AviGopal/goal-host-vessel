// A GOAL'S STATED BOUND IS GRADED AGAINST A FRESH READ BEFORE THE JUDGE, THROUGH THE REAL GATE.
//
// Gap the-trace-store-reconcile-goal-is-unreachable-by-its-producer-and-the-judge-false-accepts-it,
// general form. A goal whose target state is a measurable bound on a named quantity ("reconcile the
// trace store back under its configured cap") was graded by the LLM judge on the answer's wording, and
// the judge accepted "closer to cap, done" with the store far over its cap. Inside verifyGoalReached the
// stated-bound oracle (independent-recompute.ts verifyStatedBound) reads the quantity FRESH through its
// advertised producer (trace_store_health_observer, dry run) and decides; the judge is consulted in
// SHADOW and its verdict recorded as judge_verdict_before_pregate, never used.
//
// ONE-SIDED (qa review of the first cut): the oracle only ever says NOT REACHED (bound violated) or
// abstains. A first cut that granted reach when the bound held passed "error: could not connect" and
// "I like turtles." whenever the store happened to sit under its cap (or the counter surface fell back
// to row_count 0), ahead of every later gate, and an interim reach ended walks early.
//
// The judge stub below is the measured failure: by default it grades every answer reached. T1/T3 flip
// it to HOLLOW, so a reached verdict there can only have come from the oracle.
//
// NO LIVE SERVICES. globalThis.fetch is replaced BEFORE index.ts is imported (its bootstrap starts
// timers that call out); discovery names a fake observer vessel and a fake llm vessel, and anything
// else gets a 404.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const OBSERVER = "http://observer-vessel.test.invalid/resolve";
const LLM_VESSEL = "http://llm-vessel.test.invalid/resolve";
const JUDGE_MARK = "You verify whether a substrate execution REACHED";

const realFetch = globalThis.fetch;
let judgeCalls = 0;
let reads: string[] = [];
let observer: { row_count: number; cap: number } | "down" | "foreign" = { row_count: 234902, cap: 150000 };
let judgeSays = true;

function stubFetch(input: unknown, init?: { body?: unknown }): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? input);
  const body = typeof init?.body === "string" ? init.body : "";
  const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } }));
  if (body.includes(JUDGE_MARK)) {
    judgeCalls++;
    const verdict = JSON.stringify(judgeSays
      ? { reached: true, reason: "stub judge: the answer addresses the goal", completion_shapes: ["llm_completion_dispatch"] }
      : { reached: false, reason: "stub judge: the answer is off-topic or an error", completion_shapes: [] });
    return json({ content: { body: { content: verdict } }, body: { content: verdict } });
  }
  if (url === OBSERVER) {
    reads.push(body);
    if (observer === "down") return json({ error: "stub: observer unavailable" }, 503);
    if (observer === "foreign") return json({ shape: "traceStoreHealthReport", body: { available: true, counters_available: true, row_count: 900000, cap: 150000 } });
    const o = observer;
    return json({ shape: "traceStoreHealthReport", body: { available: true, counters_available: true, row_count: o.row_count, cap: o.cap, over_cap: o.row_count > o.cap, gap_emitted: false } });
  }
  if (body.includes('"vesselCapability"') && body.includes('"llm_completion"')) {
    return json({ content: { vessels: [{ id: "llm-test-vessel", endpoint: "http://llm-vessel.test.invalid", resolve_endpoint: LLM_VESSEL, protocol: "http" }] } });
  }
  if (body.includes('"vesselCapability"') && body.includes('"shellResult"')) {
    return json({ content: { vessels: [{ id: "shell-vessel", endpoint: "http://shell-vessel.test.invalid", resolve_endpoint: "http://shell-vessel.test.invalid/resolve", protocol: "http", origin: "local" }] } });
  }
  if (body.includes('"vesselCapability"') && body.includes('"trace_store_health_observer"')) {
    // A federated peer's row (not this substrate's) when observer === "foreign": the read must refuse it (ownOnly).
    return json({ content: { vessels: [observer === "foreign"
      ? { id: "peer-observer", endpoint: "http://peer.test.invalid", resolve_endpoint: OBSERVER, protocol: "http", origin: "peer", peerEndpoint: "http://peer.test.invalid" }
      : { id: "observer-vessel", endpoint: "http://observer-vessel.test.invalid", resolve_endpoint: OBSERVER, protocol: "http", origin: "local" }] } });
  }
  return json({ error: "stub: not served" }, 404);
}

type Verdict = { reached: boolean; reason: string; deterministic?: boolean; judge_verdict_before_pregate?: { reached: boolean | null; reason: string } };
let rewardBufferEntries: (key?: string) => number;
let verifyGoalReached: (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string, commandEvidence?: string, walkEvidence?: { gapsFiled: number; walkLog: string[] }) => Promise<Verdict | null>;

// Importing index.ts starts its persisters; point them at a state dir inside this tree so the test never writes the
// host's dispatch store or memory dump.
const stateDir = require("node:path").join(import.meta.dir, "..", ".stated-bound-gate-state");
const prevEnv = { store: process.env["GOAL_HOST_DISPATCH_STORE_PATH"], dump: process.env["MEM_DUMP_PATH"] };

beforeAll(async () => {
  require("node:fs").mkdirSync(stateDir, { recursive: true });
  process.env["GOAL_HOST_DISPATCH_STORE_PATH"] = `${stateDir}/dispatches.json`;
  process.env["MEM_DUMP_PATH"] = `${stateDir}/mem-dump.json`;
  globalThis.fetch = stubFetch as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  const mod = await import("../src/index");
  verifyGoalReached = mod.verifyGoalReached as unknown as typeof verifyGoalReached;
  ({ rewardBufferEntries } = await import("../src/llm-router"));
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevEnv.store === undefined) delete process.env["GOAL_HOST_DISPATCH_STORE_PATH"]; else process.env["GOAL_HOST_DISPATCH_STORE_PATH"] = prevEnv.store;
  if (prevEnv.dump === undefined) delete process.env["MEM_DUMP_PATH"]; else process.env["MEM_DUMP_PATH"] = prevEnv.dump;
  try { require("node:fs").rmSync(stateDir, { recursive: true, force: true }); } catch { /* temp dir */ }
});

const RECONCILE = "Reconcile the trace store back under its configured cap.";
// The walk ran one shell step and answered; the shell step is a local read, so the grounding gates in front of the
// judge (reach-grounding.ts) let these through and the judge's own verdict is what the controls see.
const SHAPES = ["goal", "dispatch_id", "shellResult", "llm_completion_dispatch"];
const answered = (goal: string, answer: string) => [
  `- goal: ${JSON.stringify({ goal })}`,
  `- dispatch_id: 6f1c1a52-0000-4000-8000-000000000001`,
  `- shellResult: {"stdout":"swap step finished","exit_code":0}`,
  `- llm_completion_dispatch: ${answer}`,
].join("\n");
const LLM_ONLY = ["goal", "dispatch_id", "llm_completion_dispatch"];
const llmOnly = (goal: string, answer: string) => [
  `- goal: ${JSON.stringify({ goal })}`,
  `- dispatch_id: 6f1c1a52-0000-4000-8000-000000000002`,
  `- llm_completion_dispatch: ${answer}`,
].join("\n");
const reset = (o: typeof observer, says = true) => { observer = o; judgeCalls = 0; reads = []; judgeSays = says; };

describe("stated-bound oracle: must-fail", () => {
  test("(a) the store over its cap → not reached, deterministic, measured/bound named; the judge's reach is recorded, not used", async () => {
    reset({ row_count: 234902, cap: 150000 });
    const walkLog: string[] = [];
    const bufferedBefore = rewardBufferEntries();
    const v = await verifyGoalReached(RECONCILE, SHAPES, "2 steps: shellResult -> llm_completion_dispatch", answered(RECONCILE, "closer to cap, done"), undefined, { gapsFiled: 0, walkLog });
    expect(v?.reached).toBe(false);
    expect(v?.deterministic).toBe(true);
    expect(v?.reason).toMatch(/^deterministic:stated-bound-violated/);
    expect(v?.reason).toContain("row_count=234902");
    expect(v?.reason).toContain("cap=150000");
    // FRESH, and a dry run: the observer must emit nothing.
    expect(reads.length).toBe(1);
    expect(JSON.parse(reads[0]!).impulse.pointer.dry_run).toBe(true);
    // SHADOW: the judge said reached, and that verdict is the one recorded, not the one returned.
    expect(judgeCalls).toBe(1);
    expect(v?.judge_verdict_before_pregate?.reached).toBe(true);
    expect(v?.judge_verdict_before_pregate?.reason).toContain("stub judge");
    expect(walkLog.some((l) => l.startsWith("[reach-shadow] judge_verdict_before_pregate reached=true"))).toBe(true);
    // The shadow line must not read as a verdict or a step to the walk-log readers.
    expect(walkLog.some((l) => /(?:HOLLOW|TRACE FAILED) — |\bstep \d+ ran /.test(l))).toBe(false);
    // The shadow call is routed under SHADOW_ROUTE_PREFIX: it adds nothing to any dispatch's reward buffer.
    expect(rewardBufferEntries()).toBe(bufferedBefore);
  }, 20_000);

  for (const answer of ["reduced rows", "swap completed", "reconciled successfully"]) {
    test(`(b) hollow answer "${answer}" to the same unreachable goal → not reached`, async () => {
      reset({ row_count: 234902, cap: 150000 });
      const v = await verifyGoalReached(RECONCILE, SHAPES, "2 steps: shellResult -> llm_completion_dispatch", answered(RECONCILE, answer));
      expect(v?.reached).toBe(false);
      expect(v?.reason).toMatch(/^deterministic:stated-bound-violated .*row_count=234902 against bound cap=150000/);
      expect(v?.judge_verdict_before_pregate?.reached).toBe(true);
    }, 20_000);
  }
});

describe("T3: a hollow answer is never reached on a bound goal (the judge says hollow; only the oracle could grant)", () => {
  const cases: Array<[string, string, { row_count: number; cap: number }]> = [
    ["the counter fallback row_count:0 + an error", RECONCILE, { row_count: 0, cap: 150000 }],
    ["under its cap + an error", RECONCILE, { row_count: 1200, cap: 150000 }],
    ["a write goal ABOUT the bound + an off-topic answer", "Write a doc explaining how to keep the trace store under its cap.", { row_count: 1200, cap: 150000 }],
    ["a write goal ABOUT the bound + the row_count:0 fallback", "Write a doc explaining how to keep the trace store under its cap.", { row_count: 0, cap: 150000 }],
  ];
  for (const [name, goal, obs] of cases) {
    for (const answer of ["error: could not connect", "I like turtles."]) {
      test(`${name}: "${answer}" → not reached`, async () => {
        reset(obs, false);
        const v = await verifyGoalReached(goal, SHAPES, "2 steps: shellResult -> llm_completion_dispatch", answered(goal, answer));
        expect(v?.reached).toBe(false);
        expect(v?.reason ?? "").not.toMatch(/stated-bound-holds/);
      }, 20_000);
    }
  }
});

describe("T5 + recursion: the shadow judge is the model's own verdict and leaves the reward buffer unchanged", () => {
  test("an LLM-only reconcile chain over its cap → the shadow records the JUDGE's verdict, not a grounding gate's", async () => {
    reset({ row_count: 234902, cap: 150000 });
    const before = rewardBufferEntries();
    const v = await verifyGoalReached(RECONCILE, LLM_ONLY, "1 step: llm_completion_dispatch", llmOnly(RECONCILE, "closer to cap, done"));
    expect(v?.reason).toMatch(/^deterministic:stated-bound-violated/);
    expect(v?.judge_verdict_before_pregate).toEqual({ reached: true, reason: "stub judge: the answer addresses the goal" });
    expect(rewardBufferEntries()).toBe(before);
  }, 20_000);

  test("the local-state gate's shadow judge (through verifyGoalReached) adds nothing to any reward buffer", async () => {
    reset({ row_count: 234902, cap: 150000 });
    const goal = "What is the structure of the full filesystem from root? List the top-level directories and what each one holds.";
    const before = rewardBufferEntries();
    // The goal targets shellResult, which this substrate's own vessel serves: a local-state question (structural).
    const v = await (verifyGoalReached as unknown as (...a: unknown[]) => Promise<Verdict | null>)(goal, LLM_ONLY, "1 step: llm_completion_dispatch", llmOnly(goal, "The root contains /bin, /etc, /home, /usr and /var."), undefined, undefined, undefined, ["shellResult"]);
    expect(v?.reached).toBe(false);
    expect(judgeCalls).toBe(1);
    expect(v?.judge_verdict_before_pregate?.reached).toBe(true);
    expect(rewardBufferEntries()).toBe(before);
  }, 20_000);
});

describe("stated-bound oracle: controls", () => {
  test("T1: the bound holding (at its cap) never grants reach: the judge decides either way", async () => {
    for (const says of [true, false]) {
      reset({ row_count: 150000, cap: 150000 }, says);
      const v = await verifyGoalReached(RECONCILE, SHAPES, "2 steps: shellResult -> llm_completion_dispatch", answered(RECONCILE, "swap completed"));
      expect(reads.length).toBe(1);
      expect(v?.reason).not.toMatch(/stated-bound/);
      expect(v?.reached).toBe(says);
      expect(v?.judge_verdict_before_pregate).toBeUndefined();
    }
  }, 20_000);

  test("a goal that does not LEAD with the target verb → abstains without reading", async () => {
    reset({ row_count: 234902, cap: 150000 });
    const goal = "Draft a proposal to reduce the trace store below its cap.";
    const v = await verifyGoalReached(goal, SHAPES, "2 steps: shellResult -> llm_completion_dispatch", answered(goal, "Proposal: lower the hot window."));
    expect(reads.length).toBe(0);
    expect(v?.reason).toBe("stub judge: the answer addresses the goal");
  }, 20_000);

  test("a constraint the oracle cannot grade ('without deleting any rows') → abstains without reading", async () => {
    reset({ row_count: 234902, cap: 150000 });
    const goal = "Reconcile the trace store back under its configured cap without deleting any rows.";
    const v = await verifyGoalReached(goal, SHAPES, "2 steps: shellResult -> llm_completion_dispatch", answered(goal, "swap completed"));
    expect(reads.length).toBe(0);
    expect(v?.reason).toBe("stub judge: the answer addresses the goal");
  }, 20_000);

  test("only a federated peer serves the observer → abstains (ownOnly): a peer's store is not this bound", async () => {
    reset("foreign");
    const v = await verifyGoalReached(RECONCILE, SHAPES, "2 steps: shellResult -> llm_completion_dispatch", answered(RECONCILE, "swap completed"));
    expect(reads.length).toBe(0);
    expect(v?.reason).toBe("stub judge: the answer addresses the goal");
    expect(v?.judge_verdict_before_pregate).toBeUndefined();
  }, 20_000);

  test("the producer unreachable → abstains: the judge decides, no shadow record", async () => {
    reset("down");
    const v = await verifyGoalReached(RECONCILE, SHAPES, "2 steps: shellResult -> llm_completion_dispatch", answered(RECONCILE, "swap completed"));
    expect(reads.length).toBe(1);
    expect(judgeCalls).toBeGreaterThan(0);
    expect(v?.reason).toBe("stub judge: the answer addresses the goal");
    expect(v?.judge_verdict_before_pregate).toBeUndefined();
  }, 20_000);

  test("a goal with no stated bound → abstains without reading: the judge decides, no shadow record", async () => {
    reset({ row_count: 234902, cap: 150000 });
    const goal = "Summarise how the trace store reconcile swap works.";
    const v = await verifyGoalReached(goal, SHAPES, "2 steps: shellResult -> llm_completion_dispatch", answered(goal, "It copies recent rows to a fresh table and swaps it in."));
    expect(reads.length).toBe(0);
    expect(v?.reason).toBe("stub judge: the answer addresses the goal");
    expect(v?.judge_verdict_before_pregate).toBeUndefined();
  }, 20_000);

  test("a bound on a DIFFERENT quantity that only mentions the store → abstains without reading", async () => {
    reset({ row_count: 234902, cap: 150000 });
    const goal = "Keep the trace store summary under 300 words.";
    const v = await verifyGoalReached(goal, SHAPES, "2 steps: shellResult -> llm_completion_dispatch", answered(goal, "The store holds recent execution traces and is swapped when over its cap."));
    expect(reads.length).toBe(0);
    expect(v?.reason).toBe("stub judge: the answer addresses the goal");
    expect(v?.judge_verdict_before_pregate).toBeUndefined();
  }, 20_000);

  test("a QUESTION about the bound → abstains: a correct 'no, it is over' is the judge's to grade", async () => {
    reset({ row_count: 234902, cap: 150000 });
    const goal = "Is the trace store under its configured cap?";
    const v = await verifyGoalReached(goal, SHAPES, "2 steps: shellResult -> llm_completion_dispatch", answered(goal, "No: 234902 rows against a cap of 150000."));
    expect(reads.length).toBe(0);
    expect(v?.reason).toBe("stub judge: the answer addresses the goal");
    expect(v?.judge_verdict_before_pregate).toBeUndefined();
  }, 20_000);
});
