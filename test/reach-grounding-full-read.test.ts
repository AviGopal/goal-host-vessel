// The full read's question and its AND (reach-grounding.ts judgeReachInParts), with a stand-in model. A part answers
// exactly one of SUPPORTS / REFUTES / NEUTRAL, never the whole-view question, whose "materially incomplete" standard and
// negation flip would grade every middle part hollow. A part that merely lacks the answer is NEUTRAL.
import { describe, expect, test } from "bun:test";
import { buildReachJudgePartPrompt, combinePartVerdicts, judgeReachInParts, parseReachJudgePartText, parseReachJudgeText } from "../src/reach-grounding";

const part = (k: number, n: number) => ({ k, n, from: (k - 1) * 23000, to: Math.min(k * 23000 + 1000, 70000), total: 70000, digest: `part ${k} body` });
const INPUT = { goal: "Summarize the node migration log for the operator.", producedShapes: ["llm_completion"], taskSummary: "walk(1 steps)", contentDigest: "- llm_completion: the whole log", now: new Date("2026-10-18T00:00:00Z") };
const answer = (o: unknown) => JSON.stringify(o);
/** A model that answers part k with verdicts[k-1], and records which parts it was asked. */
const model = (verdicts: string[], asked: number[]) => async (prompt: string) => {
  const k = Number(prompt.match(/You are reading PART (\d+) of/)![1]);
  asked.push(k);
  const v = verdicts[k - 1]!;
  return answer({ verdict: v, reason: v === "neutral" ? "this part lacks the answer; it is the middle of the log" : `part ${k} ${v}` });
};
const three = [part(1, 3), part(2, 3), part(3, 3)];

describe("one part's question and parse: exactly one of three verdicts", () => {
  test("the prompt names the part and its place in the whole, and asks for exactly one of supports / refutes / neutral", () => {
    const p = buildReachJudgePartPrompt(INPUT.goal, INPUT.producedShapes, INPUT.taskSummary, part(2, 3), "BODY-2");
    expect(p).toContain("You are reading PART 2 of 3 (chars 23000-47000 of 70000)");
    expect(p).toContain("BODY-2");
    expect(p).toContain("Classify THIS PART as EXACTLY ONE of three");
    expect(p).toContain('{"verdict": "supports" | "refutes" | "neutral"');
    expect(p).toContain('A part that merely does not hold the answer (filler, context, the middle of a log) is NEUTRAL');
  });
  test("[MUST-FAIL] the parser reads exactly the three verdicts; anything else is unparseable (null, the re-call channel)", () => {
    for (const v of ["supports", "refutes", "neutral"]) expect(parseReachJudgePartText(answer({ verdict: v, reason: "r" }))?.verdict).toBe(v);
    for (const bad of [{ verdict: "maybe" }, { verdict: "Supports" }, { supports: true, refutes: false }, { reached: true }, {}]) expect(parseReachJudgePartText(answer(bad))).toBeNull();
    expect(parseReachJudgePartText(answer({ verdict: "supports", reason: "deterministic: yes" }))?.reason).toBe("llm-claimed: yes");
  });
  test("[MUST-FAIL] the 'lacks' flip: the whole-view parser turns a reason saying 'lacks' into not-reached; a part saying it is NEUTRAL and never refutes", async () => {
    const lacks = "this part lacks the answer; it is the middle of the log";
    // The hazard, pinned: the whole-view parser's negation flip.
    expect(parseReachJudgeText(answer({ reached: true, reason: lacks }))?.reached).toBe(false);
    // The part parser has no flip: the verdict is what the part said.
    expect(parseReachJudgePartText(answer({ verdict: "neutral", reason: lacks }))).toMatchObject({ verdict: "neutral", reason: lacks });
    const v = await judgeReachInParts(INPUT, [part(1, 2), part(2, 2)], model(["neutral", "supports"], []));
    expect(v?.reached).toBe(true);
  });
});

describe("the conservative AND over tri-state parts", () => {
  test("[MUST-FAIL] (a) neutral, neutral, supports ⇒ reached, citing part 3", async () => {
    const asked: number[] = [];
    const v = await judgeReachInParts(INPUT, three, model(["neutral", "neutral", "supports"], asked));
    expect(asked).toEqual([1, 2, 3]);
    expect(v).toMatchObject({ reached: true, deterministic: false });
    expect(v?.undecided).toBeUndefined();
    expect(v?.reason).toBe("full-read: all 3 parts read (70000 chars), none refutes, and part 3/3 (chars 46000-70000 of 70000) supports the reach — part 3 supports");
  });
  test("[MUST-FAIL] (b) all neutral ⇒ undecided (the gate's abstain), NOT a not-reached verdict", async () => {
    const v = await judgeReachInParts(INPUT, three, model(["neutral", "neutral", "neutral"], []));
    expect(v?.undecided).toBe(true);
    expect(v?.reason).toBe("full-read: all 3 parts read (70000 chars) and every part is neutral — none supports or refutes the reach");
  });
  test("[MUST-FAIL] (c) neutral, refutes, supports ⇒ not reached, citing part 2, and part 3 is never asked", async () => {
    const asked: number[] = [];
    const v = await judgeReachInParts(INPUT, three, model(["neutral", "refutes", "supports"], asked));
    expect(asked).toEqual([1, 2]);
    expect(v).toMatchObject({ reached: false, deterministic: false });
    expect(v?.undecided).toBeUndefined();
    expect(v?.reason).toBe("full-read: part 2/3 (chars 23000-47000 of 70000) refutes the reach — part 2 refutes");
  });
  test("completion shapes come from the supporting parts only", () => {
    const r = (k: number, verdict: "supports" | "neutral") => ({ part: part(k, 2), verdict: { verdict, reason: `r${k}`, completion_shapes: verdict === "supports" ? ["llm_completion"] : ["x"], missing: [] } });
    expect(combinePartVerdicts([r(1, "neutral"), r(2, "supports")])).toMatchObject({ reached: true, completion_shapes: ["llm_completion"] });
  });
  test("a part the judge could not answer, or answered outside the three, makes the whole read unknown (null)", async () => {
    let i = 0;
    expect(await judgeReachInParts(INPUT, [part(1, 2), part(2, 2)], async () => (i++ === 0 ? answer({ verdict: "supports", reason: "ok" }) : null))).toBeNull();
    expect(await judgeReachInParts(INPUT, [part(1, 2), part(2, 2)], async () => answer({ verdict: "probably", reason: "?" }))).toBeNull();
  });
  test("the grounding gates read the WHOLE deliverable before any part is asked", async () => {
    let calls = 0;
    const v = await judgeReachInParts({ ...INPUT, goal: "What are you? Describe yourself." }, [part(1, 2), part(2, 2)], async () => { calls++; return answer({ verdict: "supports", reason: "ok" }); });
    expect(calls).toBe(0);
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^deterministic:ungrounded-self-description/);
  });
});
