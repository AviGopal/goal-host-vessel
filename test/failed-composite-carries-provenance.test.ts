// A NOT-REACHED WALK POSTS ITS COMPOSITE TOO — ONE CARRIER, THE WALK'S REAL FAILURE CLASS, AND WHAT
// EACH STEP CONSUMED (check-first; credit from use, failed-step provenance — user ruling 2026-10-05,
// qa 10-06).
//
// The walk builds a composite (buildCompositeTraceFromChain) whose tasks carry consumedProvenance —
// the producer→consumer edge activity-api credits a producer by (78fe52c), gated by the consumer's
// failure class (0d8334e). It is recorded only on the reached branch, and only when the last step is a
// satisfier (an engine-last walk is graded through its own last trace by POST /reach instead). So a
// consumer that FAILS in a satisfier-last walk never tells activity-api whose output it consumed.
//
// Pinned:
//   (a) walkFailureMode carries the walk's ACTUAL failure class, so activity-api's gate applies:
//       an unresolved step failure ⇒ execution_error with that reason (activity-api's classifier
//       decides environmental vs not; e.g. "fetch failed" ⇒ no producer β); a needed shape no step
//       could produce (information availability) ⇒ cascading (no producer β); otherwise the judge
//       rejected the content ⇒ verifier_negative. A failure on a shape that was later produced is
//       not the walk's cause. The failed composite carries it as failureMode.
//   (b) ONE carrier per walk, mirroring the reached branch: the failed composite only when the last
//       step is a satisfier (its trace is a walk-satisfier- satellite, which POST /reach never grades);
//       an engine-last walk is carried by its own last trace's /reach grading.
//   (c) the composite's own arm is composition:<slug> (templateId), never a pick id, so its β cannot
//       double with the lastPick β on the same arm.
//   Always: status failed, tags composite:true + reached:false; never minted; gated like β.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
type Edge = { inputShapes: string[]; inputImpulseIds: string[]; outputShapes: string[]; outputImpulseIds: string[] };
type Prov = { impulseId: string; producerExecutionId: string | null; origin: string };
type Trace = { status: string; tags?: string[]; tasks: Array<{ consumedProvenance?: Prov[] }>; compositionChain?: string[]; templateId: string; failureMode?: { type: string; reason: string } };
type FM = { type: string; reason: string };
let mod: Record<string, any>;
beforeAll(async () => {
  globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  mod = (await import("../src/index")) as Record<string, any>;
});
afterAll(() => { globalThis.fetch = realFetch; });

// Producer P (exec_P) writes analysis; the consumer step (exec_C) reads it; the walk is not reached.
const CHAIN = ["activity:⟨produce-analysis⟩", "satisfier:report"];
const EXEC_IDS = ["exec_P", "exec_C"];
const POOL = [
  { id: "walk-d1-analysis-1", metadata: { shape: "analysis", producerExecutionId: "exec_P" } },
  { id: "walk-d1-report-2", metadata: { shape: "report", producerExecutionId: "exec_C" } },
];
const EDGES: Edge[] = [
  { inputShapes: [], inputImpulseIds: [], outputShapes: ["analysis"], outputImpulseIds: ["walk-d1-analysis-1"] },
  { inputShapes: ["analysis"], inputImpulseIds: ["walk-d1-analysis-1"], outputShapes: ["report"], outputImpulseIds: ["walk-d1-report-2"] },
];
const PRODUCED = ["analysis", "report"];
const TAGS = ["dispatcher_used:goal-host"];
const CONTENT: FM = { type: "verifier_negative", reason: "judge: the report does not answer the question" };

describe("(a) MUST-FAIL — walkFailureMode carries the walk's actual failure class", () => {
  const wfm = (o: Record<string, unknown>) => (mod.walkFailureMode as (o: unknown) => FM)(o);
  test("walkFailureMode is exported", () => { expect(typeof mod.walkFailureMode).toBe("function"); });
  test("an unresolved step failure ⇒ execution_error with its reason verbatim (\"fetch failed\")", () => {
    expect(wfm({ verdictReason: "not reached", missing: ["summary"], produced: ["analysis"], satisfierFailures: new Map([["summary", "llm_completion: fetch failed"]]), pickFailures: new Map() }))
      .toEqual({ type: "execution_error", reason: "llm_completion: fetch failed" });
  });
  test("a failed engine pick whose output the walk never produced counts (its reason)", () => {
    expect(wfm({ verdictReason: "not reached", missing: [], produced: ["analysis"], satisfierFailures: new Map(), pickFailures: new Map([["activity:⟨x⟩", "runTemplate threw: request timed out"]]), pickOutputs: new Map([["activity:⟨x⟩", ["summary"]]]) }))
      .toEqual({ type: "execution_error", reason: "runTemplate threw: request timed out" });
  });
  test("(i) a pick that failed \"fetch failed\" but was routed around (its output produced later) does not decide the class: the judge's rejection does", () => {
    expect(wfm({ verdictReason: CONTENT.reason, missing: [], produced: ["analysis", "report"], satisfierFailures: new Map(), pickFailures: new Map([["activity:⟨flaky⟩", "llm_completion: fetch failed"]]), pickOutputs: new Map([["activity:⟨flaky⟩", ["analysis"]]]) }))
      .toEqual(CONTENT);
  });
  test("a failed pick with no known output shape is not attributable to a missing shape and does not decide the class", () => {
    expect(wfm({ verdictReason: CONTENT.reason, missing: [], produced: ["analysis", "report"], satisfierFailures: new Map(), pickFailures: new Map([["activity:⟨effect⟩", "fetch failed"]]), pickOutputs: new Map() }))
      .toEqual(CONTENT);
  });
  test("(ii) precedence: an unresolved SATISFIER failure (keyed by the needed shape itself) wins over an unresolved pick failure", () => {
    expect(wfm({ verdictReason: "not reached", missing: ["summary"], produced: ["analysis"], satisfierFailures: new Map([["summary", "satisfier: HTTP 503 service unavailable"]]), pickFailures: new Map([["activity:⟨x⟩", "cannot parse producer output"]]), pickOutputs: new Map([["activity:⟨x⟩", ["summary"]]]) }))
      .toEqual({ type: "execution_error", reason: "satisfier: HTTP 503 service unavailable" });
  });
  test("a needed shape nothing could produce (no recorded failure) ⇒ cascading (information availability, not the producers)", () => {
    const f = wfm({ verdictReason: "missing summary", missing: ["summary"], produced: ["analysis"], satisfierFailures: new Map(), pickFailures: new Map() });
    expect(f.type).toBe("cascading");
    expect(f.reason).toContain("summary");
  });
  test("no step failure and nothing missing ⇒ the judge rejected the content ⇒ verifier_negative with the verdict reason", () => {
    expect(wfm({ verdictReason: CONTENT.reason, missing: [], produced: ["analysis", "report"], satisfierFailures: new Map(), pickFailures: new Map() })).toEqual(CONTENT);
  });
  test("a failure on a shape that was later produced is not the walk's cause", () => {
    expect(wfm({ verdictReason: CONTENT.reason, missing: [], produced: ["analysis", "report"], satisfierFailures: new Map([["report", "fetch failed"]]), pickFailures: new Map() })).toEqual(CONTENT);
  });
});

describe("MUST-FAIL — the failed composite", () => {
  const build = (fm: FM) => (mod.buildFailedCompositeTrace as (...a: unknown[]) => Trace)(CHAIN, EXEC_IDS, PRODUCED, 10, 0, TAGS, POOL, "g", EDGES, fm);
  test("status failed, tagged composite:true + reached:false, carries the failure class, the consumer names exec_P", () => {
    const t = build({ type: "execution_error", reason: "llm_completion: fetch failed" });
    expect(t.status).toBe("failed");
    expect(t.tags).toEqual(expect.arrayContaining(["dispatcher_used:goal-host", "composite:true", "reached:false"]));
    expect(t.tags).not.toContain("reached:true");
    expect(t.failureMode).toEqual({ type: "execution_error", reason: "llm_completion: fetch failed" });
    expect(t.compositionChain).toEqual(EXEC_IDS);
    expect(t.tasks[1]!.consumedProvenance).toEqual([{ impulseId: "walk-d1-analysis-1", producerExecutionId: "exec_P", origin: "ancestor" }]);
    expect((t.tasks[0]!.consumedProvenance ?? []).filter((p) => p.producerExecutionId !== null)).toEqual([]);
  });
  test("(c) its arm is composition:<slug>, never a pick id (so its β cannot land on lastPick's arm)", () => {
    const t = build(CONTENT);
    expect(t.templateId.startsWith("composition:")).toBe(true);
    expect(CHAIN).not.toContain(t.templateId);
  });
});

describe("MUST-FAIL — wiring of the not-reached branch (source)", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
  const start = src.indexOf("} else if (verdict && verdict.reached === false) {");
  const end = src.indexOf("} else if (verdict && verdict.reached === true) {", start);
  const branch = start >= 0 && end > start ? src.slice(start, end) : "";
  test("the branch is found (guards the slice)", () => { expect(branch.length).toBeGreaterThan(1000); });
  test("(b) one carrier: only when β was not withheld, the chain has ≥ 2 steps AND the last step is a satisfier", () => {
    expect(branch).toMatch(/const _lastIsSatisfier = \(lastTrace\?\.metadata as \{ satisfier\?: boolean \} \| undefined\)\?\.satisfier === true;/);
    expect(branch).toMatch(/if \(!_noOracle && !_betaWithheldForSymmetry && chain\.length >= 2 && _lastIsSatisfier\) \{/);
  });
  test("(a) it carries walkFailureMode built from this walk's verdict, failures and produced shapes", () => {
    expect(branch).toContain("walkFailureMode({ verdictReason: verdict.reason ?? \"goal not reached\", missing: verdict.missing ?? [], produced: [...producedShapes], satisfierFailures, pickFailures, pickOutputs })");
    expect(branch).toContain("buildFailedCompositeTrace(chain, chainExecIds, [...producedShapes], totalDurationMs, totalCostUsd, [...(opts.tags ?? [])], poolImpulses, goalHashOf(goal), chain.map((_, i) => stepEdges.get(i)), _walkFailure)");
    expect(branch).toMatch(/satisfierTraceSink\.record\(_failedComposite/);
  });
  test("(i) each executed pick's output shapes are recorded where it runs", () => {
    expect(src).toContain("pickOutputs.set(pick.id, [...(pick.outputShapes ?? [])]);");
  });
  test("a failed composite is never minted", () => {
    const at = branch.indexOf("buildFailedCompositeTrace(");
    expect(at).toBeGreaterThan(-1);
    expect(branch.slice(at, at + 1500)).not.toContain("mintReachedTrace");
  });
  test("(b) the reached branch it mirrors records its composite only for a satisfier-last walk", () => {
    expect(src).toMatch(/if \(!satisfierOnly\) \{[\s\S]{0,300}\} else if \(chain\.length >= 2\) \{/);
  });
});

describe("CONTROL", () => {
  test("buildCompositeTraceFromChain (the reached path's builder) is unchanged: completed, no reach tag, no failureMode", () => {
    const t = (mod.buildCompositeTraceFromChain as (...a: unknown[]) => Trace)(CHAIN, EXEC_IDS, PRODUCED, 10, 0, TAGS, POOL, "g", EDGES);
    expect(t.status).toBe("completed");
    expect((t.tags ?? []).filter((x) => x.startsWith("reached:"))).toEqual([]);
    expect(t.failureMode).toBeUndefined();
    expect(t.tasks[1]!.consumedProvenance).toEqual([{ impulseId: "walk-d1-analysis-1", producerExecutionId: "exec_P", origin: "ancestor" }]);
  });
});
