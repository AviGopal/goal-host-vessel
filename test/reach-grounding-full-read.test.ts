// The full read's question and its AND (reach-grounding.ts judgeReachInParts), with a stand-in model. A part is asked
// whether it REFUTES and whether it SUPPORTS the reach, never the whole-view question, whose "materially incomplete"
// standard and negation flip would grade every middle part hollow.
import { describe, expect, test } from "bun:test";
import { buildReachJudgePartPrompt, combinePartVerdicts, judgeReachInParts, parseReachJudgePartText, parseReachJudgeText } from "../src/reach-grounding";

const part = (k: number, n: number) => ({ k, n, from: (k - 1) * 23000, to: Math.min(k * 23000 + 1000, 50000), total: 50000, digest: `part ${k} body` });
const INPUT = { goal: "Summarize the node migration log for the operator.", producedShapes: ["llm_completion"], taskSummary: "walk(1 steps)", contentDigest: "- llm_completion: the whole log", now: new Date("2026-10-18T00:00:00Z") };
const answer = (o: unknown) => JSON.stringify(o);

describe("one part's question and parse", () => {
  test("the prompt names the part and its place in the whole, and asks refutes/supports", () => {
    const p = buildReachJudgePartPrompt(INPUT.goal, INPUT.producedShapes, INPUT.taskSummary, part(2, 3), "BODY-2");
    expect(p).toContain("You are reading PART 2 of 3 (chars 23000-47000 of 50000)");
    expect(p).toContain("BODY-2");
    expect(p).toContain('{"supports": boolean, "refutes": boolean');
    expect(p).toContain("Content that is simply not in this part is NOT a refutation");
  });
  test("a part's reason naming what it lacks is NOT flipped (the whole-view parser would flip it)", () => {
    const text = answer({ supports: true, refutes: false, reason: "this part lacks the header but states the outcome" });
    expect(parseReachJudgePartText(text)).toMatchObject({ supports: true, refutes: false });
    expect(parseReachJudgeText(answer({ reached: true, reason: "this part lacks the header but states the outcome" }))?.reached).toBe(false);
  });
  test("a reply without both booleans is unparseable (null), and a model-written deterministic: prefix is rewritten", () => {
    expect(parseReachJudgePartText(answer({ reached: true }))).toBeNull();
    expect(parseReachJudgePartText(answer({ supports: true, refutes: false, reason: "deterministic: yes" }))?.reason).toBe("llm-claimed: yes");
  });
});

describe("the conservative AND over the parts", () => {
  test("parts are read in order and the read stops at the first refuting part, which the verdict cites", async () => {
    const asked: string[] = [];
    const v = await judgeReachInParts(INPUT, [part(1, 3), part(2, 3), part(3, 3)], async (prompt) => {
      asked.push(prompt.match(/PART (\d) of 3/)![1]!);
      return answer(prompt.includes("part 2 body") ? { supports: false, refutes: true, reason: "the status here is FAILED" } : { supports: true, refutes: false, reason: "states the outcome" });
    });
    expect(asked).toEqual(["1", "2"]);
    expect(v).toMatchObject({ reached: false, deterministic: false });
    expect(v?.reason).toBe("full-read: part 2/3 (chars 23000-47000 of 50000) refutes the reach — the status here is FAILED");
  });
  test("reached only when some part supports and none refutes", () => {
    const r = (k: number, supports: boolean) => ({ part: part(k, 2), verdict: { supports, refutes: false, reason: `r${k}`, completion_shapes: supports ? ["llm_completion"] : [], missing: [] } });
    expect(combinePartVerdicts([r(1, false), r(2, true)])).toMatchObject({ reached: true, completion_shapes: ["llm_completion"], reason: "full-read: all 2 parts read (50000 chars), none refutes, and part 2/2 (chars 23000-47000 of 50000) supports the reach — r2" });
    expect(combinePartVerdicts([r(1, false), r(2, false)])).toMatchObject({ reached: false, completion_shapes: [] });
  });
  test("a part the judge could not answer makes the whole read unknown (null), never a verdict over a subset", async () => {
    let i = 0;
    expect(await judgeReachInParts(INPUT, [part(1, 2), part(2, 2)], async () => (i++ === 0 ? answer({ supports: true, refutes: false, reason: "ok" }) : null))).toBeNull();
  });
  test("the grounding gates read the WHOLE deliverable before any part is asked", async () => {
    let calls = 0;
    const v = await judgeReachInParts({ ...INPUT, goal: "What are you? Describe yourself.", producedShapes: ["llm_completion"] }, [part(1, 2), part(2, 2)], async () => { calls++; return answer({ supports: true, refutes: false, reason: "ok" }); });
    expect(calls).toBe(0);
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^deterministic:ungrounded-self-description/);
  });
});
