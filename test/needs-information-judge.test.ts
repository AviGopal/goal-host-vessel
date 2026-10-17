/**
 * J2a at the reach judge and the wiring (src/needs-information.ts, reach-grounding.ts groundingPreGate).
 * GRADING (pre-stated with qa): a dispatch that needs information is NEVER reached. The structural flag only changes
 * WHICH not-reached grade a hedging answer gets ("needs-information", an information request) instead of
 * "non-answer"; it never lets the LLM judge grade a hedge reached, and it never blocks a real answer.
 * The flag adds NO wording. A flagged dispatch is not reached when its answer is a hedge (the existing classifier,
 * isNonAnswer, named debt) OR when its chain consulted no source in-run (the existing structural predicate the
 * current-information rule uses, hasInRunSource), so a committal "I could not find X" with nothing behind it is caught.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeReach, type ReachJudgeInput } from "../src/reach-grounding";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const stamp = (reached = true) => {
  const prompts: string[] = [];
  return { prompts, complete: async (p: string) => { prompts.push(p); return JSON.stringify({ reached, reason: "addresses the goal", completion_shapes: ["fileContent"] }); } };
};
const env = (text: string) => JSON.stringify({ success: true, shape: "llmTextCompletion", body: { text, model: "m", requested_model: "auto" } });
const input = (goal: string, answer: string, needsInformation?: boolean): ReachJudgeInput => ({
  goal, producedShapes: ["goal", "dispatch_id", "llm_completion_dispatch"], taskSummary: "walk", contentDigest: `- llm_completion_dispatch: ${env(answer)}`, now: NOW,
  ...(needsInformation === undefined ? {} : { needsInformation }),
});
// a chain that consulted a source in-run (a file read), as the walk's own reads produce
const sourced = (goal: string, answer: string, needsInformation?: boolean): ReachJudgeInput => ({
  ...input(goal, answer, needsInformation), producedShapes: ["goal", "dispatch_id", "fileContent", "llm_completion_dispatch"],
  contentDigest: `- fileContent: {"path":"config/billing.json","content":"{\\"currency\\":\\"EUR\\"}"}\n- llm_completion_dispatch: ${env(answer)}`,
});
const HEDGE = "Could you tell me which file you mean? Which one should I summarise?";

describe("J2a: the judge grades a needs-information dispatch as an information request, never reached", () => {
  it("[MF] a hedge from a dispatch flagged needs-information is not reached, graded needs-information, and the rubber-stamp judge is never consulted", async () => {
    const j = stamp(true);
    const v = await judgeReach(input("Summarise the configuration file for the billing service.", HEDGE, true), j.complete);
    expect(v?.reached).toBe(false);
    expect(String(v?.reason)).toContain("needs-information");
    expect(j.prompts.length).toBe(0);
  });
  it("[PARAPHRASE] other hedging wordings, other goals: the same grade", async () => {
    for (const [g, a] of [
      ["Report the line count of the deployment manifest.", "Could you provide the manifest's path?"],
      ["Extract the version string from the release notes file.", "Please provide the location of the release notes."],
      ["Show the first heading in the onboarding guide.", "Can you share where the guide is? Let me know and I will read it."],
    ] as const) {
      const v = await judgeReach(input(g, a, true), stamp(true).complete);
      expect(v?.reached).toBe(false);
      expect(String(v?.reason)).toContain("needs-information");
    }
  });
  it("[CONTROL] the same hedge WITHOUT the structural flag keeps today's grade (non-answer), not the information-request grade", async () => {
    const v = await judgeReach(input("Summarise the configuration file for the billing service.", HEDGE), stamp(true).complete);
    expect(v?.reached).toBe(false);
    expect(String(v?.reason)).toContain("non-answer");
  });
  it("[MF] a COMMITTAL answer from a flagged dispatch that consulted no source in-run is not reached (needs-information): nothing it says could rest on anything", async () => {
    const j = stamp(true);
    const v = await judgeReach(input("Summarise the configuration file for the billing service.", "I could not find the billing configuration file.", true), j.complete);
    expect(v?.reached).toBe(false);
    expect(String(v?.reason)).toContain("needs-information");
    expect(j.prompts.length).toBe(0);
  });
  it("[PARAPHRASE] other committal wordings with no in-run source: the same grade", async () => {
    for (const a of ["The billing service config sets the currency to EUR.", "There is no such file in this repository.", "The file is empty."]) {
      const v = await judgeReach(input("Summarise the configuration file for the billing service.", a, true), stamp(true).complete);
      expect(v?.reached).toBe(false);
      expect(String(v?.reason)).toContain("needs-information");
    }
  });
  it("[HELD-OUT] a REAL answer from a flagged dispatch whose chain DID consult a source in-run is not blocked: the judge decides it", async () => {
    const j = stamp(true);
    const v = await judgeReach(sourced("Summarise the configuration file for the billing service.", "The billing service config sets the currency to EUR, retries to 3 and the invoice day to the 1st.", true), j.complete);
    expect(j.prompts.length).toBe(1);
    expect(v?.reached).toBe(true);
  });
  it("[CONTROL] the same committal text from a dispatch NOT flagged goes to the judge as before", async () => {
    const j = stamp(true);
    await judgeReach(input("Summarise the configuration file for the billing service.", "I could not find the billing configuration file."), j.complete);
    expect(j.prompts.length).toBe(1);
  });
});

describe("J2a wiring (index.ts)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
  it("[WIRING] the a.5 site records pool-bind and investigation attempts; a produced shape clears its record", () => {
    expect(src).toContain('_niRec?.noteUnderived(shape, _niUnbound, "pool_bind");');
    expect(src).toContain('if (_niInvestigated) _niRec?.noteUnderived(shape, _niUnbound, "investigation");');
    expect(src).toContain("if (r) unboundFor(opts.variables?.dispatch_id)?.noteAccepted(shape);");
  });
  it("[WIRING] the terminal record write classifies needs-information only when not reached, and drops the record", () => {
    expect(src).toContain("const _ni = needsInformationOutcome(unboundByDispatch.get(String(variables?.dispatch_id ?? record.dispatchId ?? \"\")), seek.reached === true);");
    expect(src).toContain("unboundByDispatch.delete(String(variables?.dispatch_id ?? record.dispatchId ?? \"\"));");
  });
  it("[WIRING] the reach judge receives the structural flag", () => {
    expect(src).toContain("needsInformation: dispatchNeedsInformation()");
  });
});
