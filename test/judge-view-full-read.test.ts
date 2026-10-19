// FULL VIEW OR ABSTAIN (reach condition 5), THROUGH THE REAL GATE. A deliverable larger than the judge's 24,000-char
// view is read WHOLE, in ordered parts, when the end-of-walk view has it in hand; the verdict is the conservative AND
// over the parts (any refuting part ⇒ not reached) and cites the part that decided it. On the parent sha the view
// carries no whole copy, so every such deliverable is an abstain:cut-view — ungraded whatever lies past the cut.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildJudgeView, DELIVERABLE_CAP } from "../src/judge-view";

const JUDGE_MARK = "You verify whether a substrate execution REACHED";
const PARTS_MARK = "ORDERED PARTS";
const LLM_VESSEL = "http://llm-vessel.test.invalid/resolve";
const realFetch = globalThis.fetch;
let wholeViewCalls = 0;
let partCalls: number[] = [];
const reply = (o: unknown) => {
  const verdict = JSON.stringify(o);
  return Promise.resolve(new Response(JSON.stringify({ content: { body: { content: verdict } }, body: { content: verdict } }), { status: 200, headers: { "Content-Type": "application/json" } }));
};
// The stub judge reads only what it is shown: the whole-view judge passes whatever head it sees; a part refutes on the
// failure marker, supports on the success or answer marker, and is otherwise NEUTRAL with a reason saying what it lacks
// (the words the whole-view parser would flip to not-reached). `partsDown`: the judge answers no part (null).
let partsDown = false;
function stubFetch(_input: unknown, init?: { body?: unknown }): Promise<Response> {
  const body = typeof init?.body === "string" ? init.body : "";
  if (body.includes(JUDGE_MARK) && body.includes(PARTS_MARK)) {
    const k = Number(body.match(/You are reading PART (\d+) of \d+/)?.[1] ?? 0);
    partCalls.push(k);
    if (partsDown) return Promise.resolve(new Response(JSON.stringify({ error: "stub: judge down" }), { status: 503 }));
    const verdict = body.includes("FAILED-MARK") ? "refutes" : body.includes("migrated cleanly") || body.includes("ANSWER-MARK") ? "supports" : "neutral";
    return reply({ verdict, reason: verdict === "refutes" ? "stub part: the final status says the migration FAILED" : verdict === "supports" ? "stub part: the report states the outcome" : "stub part: this part lacks the answer, it is filler only", completion_shapes: verdict === "supports" ? ["llm_completion"] : [] });
  }
  if (body.includes(JUDGE_MARK)) {
    wholeViewCalls++;
    return reply({ reached: true, reason: "stub judge: the report reads complete", completion_shapes: ["llm_completion"] });
  }
  if (body.includes('"vesselCapability"') && body.includes('"llm_completion"')) {
    return Promise.resolve(new Response(JSON.stringify({ content: { vessels: [{ id: "llm-test-vessel", endpoint: "http://llm-vessel.test.invalid", resolve_endpoint: LLM_VESSEL, protocol: "http" }] } }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  return Promise.resolve(new Response(JSON.stringify({ error: "stub: not served" }), { status: 404 }));
}
type V = { reached: boolean; reason: string; abstain?: { kind: string }; full_read?: { parts: number; chars: number } } | null;
let verifyGoalReached: (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string, commandEvidence?: string, walkEvidence?: unknown, judgeView?: unknown) => Promise<V>;
let oracleAbstainCounts: () => Record<string, { decisions: number; verdicts: number; abstains: number }>;
const prevRoot = process.env["WORKSPACE_ROOT"];
const tmpRoot = `${require("node:os").tmpdir()}/judge-view-full-read-${process.pid}`;
beforeAll(async () => {
  require("node:fs").mkdirSync(`${tmpRoot}/policies`, { recursive: true });
  process.env["WORKSPACE_ROOT"] = tmpRoot;
  globalThis.fetch = stubFetch as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  const mod = await import("../src/index");
  verifyGoalReached = mod.verifyGoalReached as unknown as typeof verifyGoalReached;
  oracleAbstainCounts = mod.oracleAbstainCounts as unknown as typeof oracleAbstainCounts;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevRoot;
  try { require("node:fs").rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp dir */ }
});

const GOAL = "Summarize the main points of the long node migration log in one report for the operator.";
const FILLER = "Node log line: step applied, checkpoint written. ".repeat(Math.ceil((DELIVERABLE_CAP + 2000) / 50));
/** The end-of-walk view of a pool whose only deliverable is `report` (the gate is handed exactly what the walk hands it). */
const endOfWalk = (report: string) => {
  const view = buildJudgeView([{ shape: "llm_completion", content: report }], new Set(), new Set(), { full: true });
  return { view, run: () => verifyGoalReached(GOAL, ["goal", "llm_completion"], "walk(1 steps)", view.digest, undefined, undefined, view) };
};
const reset = () => { wholeViewCalls = 0; partCalls = []; partsDown = false; };
/** `n` chars of the migration log's filler (neutral to every part). */
const LOG = (n: number) => "Node log line: step applied, checkpoint written. ".repeat(Math.ceil(n / 50)).slice(0, n);

describe("a deliverable larger than the judge's view is judged on its FULL content", () => {
  test("[MUST-FAIL] (i) refuting content past the cut: NOT reached, graded (not an abstain), citing the refuting part", async () => {
    reset();
    const { view, run } = endOfWalk("Migration report. All nodes migrated cleanly. " + FILLER + " FINAL STATUS: FAILED-MARK on 3 of 5 nodes.");
    expect(view.deliverableCut).toBe(true);
    expect(view.digest).not.toContain("FAILED-MARK"); // the cut view alone would read as a clean report
    const v = await run();
    expect(v).not.toBeNull();
    expect(v?.abstain).toBeUndefined();
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^full-read: part 2\/2 \(chars \d+-\d+ of \d+\) refutes the reach — stub part: the final status says the migration FAILED/);
    expect(v?.full_read).toEqual({ parts: 2, chars: view.full!.deliverable.length });
    expect(partCalls).toEqual([1, 2]);
    expect(wholeViewCalls).toBe(0); // the cut view is never graded as if it were whole
  }, 20_000);
  test("[MUST-FAIL] (ii) the answer past the cut: the full read IS judged on it, reached, and the verdict cites that part", async () => {
    reset();
    const { view, run } = endOfWalk(FILLER + " ANSWER-MARK: the migration moved 5 of 5 nodes.");
    expect(view.digest).not.toContain("ANSWER-MARK");
    const v = await run();
    expect(v?.abstain).toBeUndefined();
    expect(v?.reached).toBe(true);
    expect(v?.reason).toMatch(/^full-read: all 2 parts read \(\d+ chars\), none refutes, and part 2\/2 \(chars \d+-\d+ of \d+\) supports the reach — stub part: the report states the outcome/);
    expect(v?.full_read?.parts).toBe(2);
    expect(partCalls).toEqual([1, 2]);
  }, 20_000);
  test("[MUST-FAIL] (a) neutral, neutral, supports: reached, citing part 3 (a middle part that lacks the answer never refutes)", async () => {
    reset();
    const { view, run } = endOfWalk(LOG(50000) + " ANSWER-MARK: the migration moved 5 of 5 nodes.");
    const v = await run();
    expect(v?.abstain).toBeUndefined();
    expect(v?.reached).toBe(true);
    expect(v?.reason).toMatch(/^full-read: all 3 parts read \(\d+ chars\), none refutes, and part 3\/3 \(chars \d+-\d+ of \d+\) supports the reach/);
    expect(v?.full_read).toEqual({ parts: 3, chars: view.full!.deliverable.length });
    expect(partCalls).toEqual([1, 2, 3]);
  }, 20_000);
  test("[MUST-FAIL] (b) every part neutral: abstain:cut-view (ungraded), NOT a not-reached verdict", async () => {
    reset();
    const v = await endOfWalk(LOG(50000)).run();
    expect(v?.abstain?.kind).toBe("cut-view");
    expect(v?.reason).toMatch(/^abstain:cut-view — .* read in full in 3 parts, but every part was neutral \(none supports or refutes the reach\); not graded$/);
    expect(v?.full_read?.parts).toBe(3);
    expect(partCalls).toEqual([1, 2, 3]);
  }, 20_000);
  test("[MUST-FAIL] (c) neutral, refutes, supports: not reached, citing part 2, and part 3 is never read", async () => {
    reset();
    const v = await endOfWalk(LOG(30000) + " FAILED-MARK on 3 of 5 nodes. " + LOG(25000) + " ANSWER-MARK: done.").run();
    expect(v?.abstain).toBeUndefined();
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^full-read: part 2\/3 \(chars \d+-\d+ of \d+\) refutes the reach — stub part: the final status says the migration FAILED/);
    expect(partCalls).toEqual([1, 2]);
  }, 20_000);
  test("a full read is counted as a VERDICT in the judge-view-cut family, not an abstain", async () => {
    reset();
    const before = oracleAbstainCounts()["judge-view-cut"] ?? { decisions: 0, verdicts: 0, abstains: 0 };
    await endOfWalk(FILLER + " ANSWER-MARK: done.").run();
    const after = oracleAbstainCounts()["judge-view-cut"]!;
    expect(after.verdicts).toBe(before.verdicts + 1);
    expect(after.abstains).toBe(before.abstains);
  }, 20_000);
});

describe("when the full read is not possible, the verdict stays ungraded (abstain:cut-view) and says why", () => {
  test("over the shaped part budget (default 4 parts): abstain, no judge call", async () => {
    reset();
    const { run } = endOfWalk(FILLER.repeat(5) + " ANSWER-MARK: done.");
    const v = await run();
    expect(v?.abstain?.kind).toBe("cut-view");
    expect(v?.reason).toMatch(/^abstain:cut-view — .* could not be read in full \(it needs more than the 4-part full-read budget\); not graded$/);
    expect(partCalls).toEqual([]);
    expect(wholeViewCalls).toBe(0);
  }, 20_000);
  test("a view with no whole copy (the interim check's): abstain, as before", async () => {
    reset();
    const view = buildJudgeView([{ shape: "llm_completion", content: FILLER + " ANSWER-MARK" }], new Set());
    const v = await verifyGoalReached(GOAL, ["goal", "llm_completion"], "walk(1 steps)", view.digest, undefined, undefined, view);
    expect(v?.abstain?.kind).toBe("cut-view");
    expect(v?.reason).toContain("no whole copy reached the gate");
    expect(partCalls).toEqual([]);
  }, 20_000);
});

describe("control: a deliverable that fits the view is judged exactly as before", () => {
  test("one whole-view judge call, its verdict and reason unchanged, no full read", async () => {
    reset();
    const { view, run } = endOfWalk("Migration report. All nodes migrated cleanly.");
    expect(view.deliverableCut).toBe(false);
    const v = await run();
    expect(wholeViewCalls).toBe(1);
    expect(partCalls).toEqual([]);
    expect(v?.reached).toBe(true);
    expect(v?.reason).toBe("stub judge: the report reads complete");
    expect(v?.full_read).toBeUndefined();
  }, 20_000);
});

// (iii) UNGRADED IS NO WRITE, on every path that can end ungraded. The walk already holds it (judge-view-gate.test.ts
// pins the β withhold and the two `!walkAbstain` path rows; α, mint and bank sit under reached===true, which an abstain
// never is). The single-template recovery attempt and the floor did not: each wrote a FAILED path row for an abstained
// verdict, and that row's POST adds failure_delta / thompson_beta — a β on a verdict nobody graded.
describe("(iii) a run that ends ungraded writes no α/β and no goal-path row (source)", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
  test("control (walk): an abstain withholds β and writes no path row", () => {
    expect(src).toMatch(/if \(verdict\?\.abstain\) \{\n\s*status = "failed";\n\s*walkBetaWithheld = true;\n\s*\} else if \(verdict && verdict\.reached === false\)/);
    expect(src.match(/void recordGoalPath\(goal, chain, reached,/g) ?? []).toHaveLength(2);
    expect(src.match(/!walkAbstain\) void recordGoalPath\(goal, chain, reached,/g) ?? []).toHaveLength(2);
  });
  test("[MUST-FAIL] the recovery attempt: an abstained attempt is not penalised and writes no path row", () => {
    const a = src.indexOf("} else if (verdict?.abstain) {\n          // ABSTAIN (OP-1)");
    expect(a).toBeGreaterThan(0);
    expect(src.slice(a, a + 400)).not.toContain("penaliseHollowTemplate");
    expect(src).toContain("attemptAbstained = !!verdict?.abstain;");
    expect(src).toContain('if (opts.learningMode !== "observe" && goal && selId && !attemptAbstained) void recordGoalPath(goal, [selId], reached,');
    expect(src.match(/void recordGoalPath\(goal, \[selId\], reached,/g) ?? []).toHaveLength(1);
  });
  test("[MUST-FAIL] the floor: an abstained floor verdict is carried out, and the failed floor row is not written for it", () => {
    expect(src).toContain("if (out && verdict?.abstain) out.abstain = true;");
    expect(src).toContain('if (!uf?.reached && opts.learningMode !== "observe" && !_ufOut.abstain) void recordGoalPath(goal, ["universal-tool-fallback"], false,');
  });
});
