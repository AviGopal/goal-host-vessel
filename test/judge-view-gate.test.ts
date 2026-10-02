// V3 WIRING, THROUGH THE REAL GATE. A cut deliverable is an ABSTAIN computed in code before the judge
// is called (REALIGNMENT §9.2): verifyGoalReached returns null (the "verdict unknown" channel, no β)
// and the judge is never consulted. On the parent sha the cut record is ignored and the judge grades
// the cut view. Plus source pins: both walk sites read the same view, and completion_shapes are
// restricted before any reader.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const JUDGE_MARK = "You verify whether a substrate execution REACHED";
const LLM_VESSEL = "http://llm-vessel.test.invalid/resolve";
const realFetch = globalThis.fetch;
let judgeCalls = 0;
function stubFetch(_input: unknown, init?: { body?: unknown }): Promise<Response> {
  const body = typeof init?.body === "string" ? init.body : "";
  const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } }));
  if (body.includes(JUDGE_MARK)) {
    judgeCalls++;
    const verdict = JSON.stringify({ reached: false, reason: "stub judge: missing a coherent report format", completion_shapes: ["activity_template"] });
    return json({ content: { body: { content: verdict } }, body: { content: verdict } });
  }
  if (body.includes('"vesselCapability"') && body.includes('"llm_completion"')) {
    return json({ content: { vessels: [{ id: "llm-test-vessel", endpoint: "http://llm-vessel.test.invalid", resolve_endpoint: LLM_VESSEL, protocol: "http" }] } });
  }
  return json({ error: "stub: not served" }, 404);
}
type V = { reached: boolean; reason: string } | null;
let verifyGoalReached: (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string, commandEvidence?: string, walkEvidence?: unknown, judgeView?: unknown) => Promise<V>;
const prevRoot = process.env["WORKSPACE_ROOT"];
const tmpRoot = `${require("node:os").tmpdir()}/judge-view-gate-${process.pid}`;
beforeAll(async () => {
  require("node:fs").mkdirSync(`${tmpRoot}/policies`, { recursive: true });
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

const GOAL = "Summarize the main points of the long design discussion in one report.";
describe("cut view ⇒ abstain, before the judge", () => {
  test("must-fail on parent: a cut deliverable is an explicit ABSTAIN carrying the cut — not null, and not handed to the judge", async () => {
    judgeCalls = 0;
    const cuts = [{ shape: "llm_completion", shown: 1500, produced: 4965 }];
    const v = await verifyGoalReached(GOAL, ["goal", "llm_completion"], "walk(1 steps)", "- llm_completion: " + "r".repeat(1500), undefined, undefined,
      { deliverableCut: true, cuts }) as ({ reached: boolean; reason: string; abstain?: { kind: string; cuts: unknown[] } } | null);
    // NOT the null "verdict unknown" channel: the walk's verifier re-call loop (`verdict == null`) does not fire.
    expect(v).not.toBeNull();
    expect(v?.reached).toBe(false);
    expect(v?.abstain).toEqual({ kind: "cut-view", cuts });
    expect(v?.reason).toMatch(/^abstain:cut-view/);
    expect(v?.reason).not.toMatch(/unreachable|verdict unknown/);
    expect(judgeCalls).toBe(0);
  });
  test("positive control: an uncut view reaches the judge as before", async () => {
    judgeCalls = 0;
    const v = await verifyGoalReached(GOAL, ["goal", "llm_completion"], "walk(1 steps)", "- llm_completion: a full report", undefined, undefined, { deliverableCut: false, cuts: [] });
    expect(judgeCalls).toBeGreaterThan(0);
    expect(v?.reason).toBe("stub judge: missing a coherent report format");
  }, 20_000);
});

describe("an abstain triggers no retry and is named, not logged as an outage (source)", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
  test("the walk's verifier re-call loop keys on null only, so a (non-null) abstain is never re-called", () => {
    expect(src).toMatch(/for \(let _r = 0; verdict == null && _r < 2; _r\+\+\)/);
  });
  test("the walk names the abstain, records it on its result, and withholds β instead of the hollow branch", () => {
    const i = src.indexOf("if (verdict?.abstain) {\n        walkAbstain = verdict.abstain;");
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i, i + 300)).toContain("walk(${opts.surface}): ABSTAIN");
    expect(src).toMatch(/if \(verdict\?\.abstain\) \{\n\s*status = "failed";\n\s*walkBetaWithheld = true;\n\s*\} else if \(verdict && verdict\.reached === false\)/);
    expect(src).toContain("...(walkAbstain ? { abstain: walkAbstain } : {}),");
  });
  test("the dispatch returns an abstained walk before FEEDBACK-RETRY, the satisfier retry, the re-frame and the floor", () => {
    const a = src.indexOf("if (walk.abstain) {");
    expect(a).toBeGreaterThan(0);
    expect(src.slice(a, a + 300)).toContain("return walk;");
    for (const later of ["walk: FEEDBACK-RETRY", "re-running with suppressSatisfierShapes", "re-framing to alternative target shapes", "const uf = await universalToolFallback("]) {
      expect(src.indexOf(later, a)).toBeGreaterThan(a);
    }
  });
  test("an abstain from any retry walk is honoured BEFORE the attempts>0 choice can drop it", () => {
    expect(src).toMatch(/if \(fbWalk\.abstain\) return fbWalk;[^\n]*\n\s*walk = fbWalk\.attempts > 0 \? fbWalk : walk;/);
    expect(src).toMatch(/if \(retryWalk\.abstain\) return retryWalk;[^\n]*\n\s*walk = retryWalk\.attempts > 0 \? retryWalk : walk;/);
    expect(src).toMatch(/if \(altWalkResult\.abstain\) \{\n\s*return altWalkResult;/);
  });
  test("must-fail (qa7): an abstained walk writes no path row (its POST would add failure_delta / thompson_beta)", () => {
    expect(src).toContain('if (opts.learningMode !== "observe" && !walkAbstain) void recordGoalPath(goal, chain, reached,');
    expect(src).toContain("if (!walkAbstain) void recordGoalPath(goal, chain, reached,");
    expect(src.match(/void recordGoalPath\(goal, chain, reached,/g) ?? []).toHaveLength(2);
  });
  test("a fallback trace for an abstained dispatch is labelled as an abstain, not an unreached termination", () => {
    expect(src).toContain('seek.abstain ? "walk-abstained" : "walk-terminated-unreached"');
  });
  test("/resolve does not reward or penalise the router on an abstain, and reports it as ungraded", () => {
    expect(src).toContain('if (!seek.abstain) void flushRouterFeedback(goalHashOf(String(goal ?? "")), seek.reached === true);');
    expect(src).toContain("...(seek.abstain ? { reached: null, abstain: seek.abstain } : {}),");
  });
  test("an abstain never becomes failure memory", () => {
    expect(src).toContain("if (/^abstain:/i.test(r) ||");
  });
});

describe("completion_shapes are chosen in code for EVERY caller (engine path, floor, walk)", () => {
  test("must-fail on parent: a call with no walk context (the engine path / the floor) gets the judge's junk name stripped", async () => {
    const v = await verifyGoalReached(GOAL, ["goal", "llm_completion", "activity_template"], "engine", "- llm_completion: a full report") as { completion_shapes?: string[] } | null;
    expect(v?.completion_shapes).toEqual([]);
  });
  test("a deliverable the goal targets is never stripped (activity_template / test_suite can be the deliverable)", async () => {
    const v = await verifyGoalReached(GOAL, ["goal", "llm_completion", "activity_template"], "walk", "- llm_completion: a full report", undefined, undefined, { deliverableCut: false, cuts: [] }, ["activity_template"]) as { completion_shapes?: string[] } | null;
    expect(v?.completion_shapes).toEqual(["activity_template"]);
  });
});

describe("an abstain is ungraded at the dispatch: reached=null, no /reach, no router reward, a label with the cut (source)", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
  test("the dispatch record carries reached=null (deliverReachVerdict skips a non-boolean) and the abstain", () => {
    expect(src).toMatch(/if \(seek\.abstain\) \{\n\s*record\.reached = null;\n\s*\(record as \{ abstain\?: unknown \}\)\.abstain = seek\.abstain;/);
    expect(src).toContain('typeof reached !== "boolean"');
  });
  test("the router is not rewarded or penalised on an abstain", () => {
    expect(src).toContain('if (learningMode !== "observe" && !seek.abstain) void flushRouterFeedback(');
  });
  test("the abstain writes a non-binary automated label carrying the cuts", () => {
    const i = src.indexOf('source: "judge-abstain-cut-view"');
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i - 300, i + 200)).toContain('verdict: "partial", labeler: "automated"');
    expect(src.slice(i, i + 200)).toContain("cuts=${JSON.stringify(verdict.abstain.cuts)}");
  });
});

describe("source wiring", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
  test("both walk reach sites build the same judge view and pass it to the gate", () => {
    expect(src.match(/buildJudgeView\(/g) ?? []).toHaveLength(2);
    expect(src).toMatch(/interimCommandEvidence \|\| undefined,\s*undefined,\s*interimView,/);
    expect(src.match(/walkEv, judgeView, \[\.\.\.terminalShapes, \.\.\.target\], poolEvidenceOf\(poolImpulses\)\)/g) ?? []).toHaveLength(2);
  });
  test("no judge digest is cut at a blind 8,000 after assembly", () => {
    expect(src).not.toMatch(/\[poolDigest, capturedDigest\]/);
    expect(src).not.toMatch(/\[interimCaptured, interimPool\]/);
  });
  test("completion_shapes are restricted inside verifyGoalReached, so every site reads restricted names", () => {
    const i = src.indexOf("async function verifyGoalReached(");
    expect(src.slice(i, i + 900)).toContain("restrictCompletionShapes(v.completion_shapes, new Set(producedShapes), false, keep)");
  });
});
