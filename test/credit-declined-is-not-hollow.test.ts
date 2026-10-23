// A CORRECT REFUSAL IS NOT A HOLLOW (design ruling: outcomes are reached / failed / DECLINED; a declined outcome
// carries its reason as a shaped, queryable impulse).
//
// WHY. A satisfier whose own answer refused correctly — satisfier:gapDecomposition answering needs_information, or
// its armDecomposition gate refusing every proposed step — ends the walk not reached, deterministically. The β block
// then charged the last pick through penaliseHollowTemplate (/v2/activities/feedback, intensity 2) exactly as a
// hollow answer, and the durable trace carried reached:false, never the declined:<class> tag activity-api's
// isReachInapplicable already ungrades. A right refusal was graded as a wrong answer.
//
// THE RULES PINNED HERE:
//   - satisfierDeclineClass reads the decline from the answer itself (the decliner's own markers), never the goal;
//   - creditOnHollow withholds β with reason "declined" when its input says the answer declined, first in the ladder;
//   - the walk feeds the decline from the last pick's pooled answer, makes no penalise call for it, and the durable
//     trace carries declined:<class> with the decliner's reason in metadata;
//   - CONTROL: a genuinely hollow answer (and a decomposer that FAILED rather than refused) is charged as before.
//
// The walk needs a live host and the fleet, so its sequence is pinned on the source (as credit-gate-symmetry and
// citation-oracle-culpability do); the decision and the classifier are driven directly.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as judge from "../src/judge/entries";
import { creditInput } from "../src/judge/inputs";
import { creditOnHollowInput } from "../src/judge/capture";
import { capturedToReplay } from "../src/judge/captured-to-replay";
import { JUDGE_INPUT_SCHEMA } from "../src/judge/records";

const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
const branch = (() => {
  const start = SRC.indexOf("} else if (verdict && verdict.reached === false) {");
  const end = SRC.indexOf("} else if (verdict && verdict.reached === true) {", start);
  return start >= 0 && end > start ? SRC.slice(start, end) : "";
})();
const persist = SRC.slice(SRC.indexOf("if (satisfierOnlyTrace) {"), SRC.indexOf("persistWithinDeadline(persistSatisfierTrace(durableTrace)"));

// The loop-test shape: satisfier:gapDecomposition answering needs_information (development-vessel decomposeGap).
const NEEDS_INFO = { shape: "gapDecomposition", body: { ok: false, stage: "decompose", gap_id: "g-1", children: [], reason: "needs_information: no readable edit site (no edit_site and nothing localises)", created: [], prior_children: 0 } };
// armDecomposition refusing every proposed step.
const REFUSED = { ok: false, stage: "decompose", gap_id: "g-2", children: [], reason: "no valid step: step 1: no machine-checkable falsifier", created: [], prior_children: 0 };
// A deterministic hollow on a culpable last pick: the case the β charge exists for.
const hollow = (declined?: string | null) => creditInput({ templateClass: "satisfier:gapDecomposition", deterministic: true, noOracle: false, consumedInChain: 0, lastPickProducedJudgedArtifact: true, declined });

describe("MUST-FAIL: a satisfier's correct refusal is declined, not charged", () => {
  test("the classifier reads needs_information and an armDecomposition refusal from the answer itself", () => {
    expect(judge.satisfierDeclineClass(NEEDS_INFO)).toEqual({ class: "needs_information", reason: NEEDS_INFO.body.reason });
    expect(judge.satisfierDeclineClass(REFUSED)?.class).toBe("decomposition_refused");
    expect(judge.satisfierDeclineClass({ ...REFUSED, reason: "cannot_falsify: the defect has no observable" })?.class).toBe("decomposition_refused");
    expect(judge.satisfierDeclineClass({ ...REFUSED, reason: "a decomposed step is not decomposed again" })?.class).toBe("decomposition_refused");
  });

  test("creditOnHollow withholds β as declined, ahead of every other reason, and charges nothing", () => {
    const d = judge.creditOnHollow(hollow("needs_information"));
    expect(d).toEqual({ alpha_reachable: true, charge: false, withheld: "declined", retire_candidate: false });
    // first in the ladder: a declined answer under a missing oracle is still a decline
    const n = judge.creditOnHollow(creditInput({ templateClass: "t", deterministic: false, noOracle: true, consumedInChain: 0, lastPickProducedJudgedArtifact: true, declined: "decomposition_refused" }));
    expect(n.withheld).toBe("declined");
  });

  test("the walk feeds the decline from the last pick's own pooled answer into the closed decision", () => {
    expect(branch).toContain("judge.satisfierDeclineClass(poolImpulses.find((i) => (i.metadata as { producedBy?: unknown }).producedBy === lastPick)?.content)");
    expect(branch).toContain("declined: _declined?.class ?? null }));");
    expect(branch).toContain("if (_declined) walkBetaWithheld = true;");
  });

  test("the walk makes no /v2/activities/feedback penalty call for a decline", () => {
    // the branch has one penaliseHollowTemplate call, and a decline never reaches it
    expect(branch.split("penaliseHollowTemplate(").length - 1).toBe(1);
    // a decline takes the first arm, which only logs; the penalty sits in the arm after it
    const declinedArm = branch.indexOf("if (_declined) {\n          tap(");
    const guard = branch.indexOf("} else if (!_noOracle && !_betaWithheldForSymmetry) {");
    const call = branch.indexOf("penaliseHollowTemplate(lastPick,");
    expect(declinedArm).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(declinedArm);
    expect(call).toBeGreaterThan(guard);
    expect(branch.slice(declinedArm, guard)).not.toContain("penaliseHollowTemplate(");
  });

  test("the durable trace carries declined:<class> and the decliner's reason", () => {
    expect(persist).toContain("if (!reached && walkDeclined) { durableTrace.tags = [...(durableTrace.tags ?? []).filter((t) => !t.startsWith(\"declined:\")), `declined:${walkDeclined.class}`];");
    expect(persist).toContain("decline: { class: walkDeclined.class, reason_text: walkDeclined.reason, decliner_id: String(lastPick) }");
    // after the withheld tags (which would otherwise replace the tag list), before the persist
    expect(persist.indexOf("if (!reached && walkDeclined)")).toBeGreaterThan(persist.indexOf("durableTrace.tags = withBetaWithheld("));
  });

  test("the capture records the decline and its replay decides the same withhold", () => {
    const cap = creditOnHollowInput({ templateId: "satisfier:gapDecomposition", verdict: { deterministic: true, reason: "deterministic:x" }, consumedInChain: 0, editEffectReach: null, lastPickProducedJudgedArtifact: true, noOracle: false, declined: "needs_information" });
    expect((cap as { declined?: string }).declined).toBe("needs_information");
    const r = capturedToReplay({ schema: JUDGE_INPUT_SCHEMA, entry: "creditOnHollow", input: cap });
    expect(r.ok).toBe(true);
    if (r.ok) expect(judge.creditOnHollow(r.input as Parameters<typeof judge.creditOnHollow>[0]).withheld).toBe("declined");
  });
});

describe("CONTROL: a genuinely hollow answer is charged exactly as today", () => {
  test("no decline: a deterministic hollow on a culpable last pick is charged", () => {
    expect(judge.creditOnHollow(hollow())).toEqual({ alpha_reachable: true, charge: true, withheld: null, retire_candidate: false });
    expect(judge.creditOnHollow(hollow(null)).charge).toBe(true);
  });

  test("a decomposer that FAILED, or an answer that wrote something, is not a decline", () => {
    expect(judge.satisfierDeclineClass({ ...REFUSED, reason: "llm call failed: timeout" })).toBeNull();
    expect(judge.satisfierDeclineClass({ ...REFUSED, reason: "no llm_completion producer" })).toBeNull();
    expect(judge.satisfierDeclineClass({ ...REFUSED, reason: "unparseable decomposition", raw_len: 12 })).toBeNull();
    expect(judge.satisfierDeclineClass({ ok: true, stage: "decompose", children: ["g-2-step-1"], reason: "wrote 1 step(s)" })).toBeNull();
    expect(judge.satisfierDeclineClass({ ...REFUSED, children: ["g-2-step-1"] })).toBeNull();
    expect(judge.satisfierDeclineClass({ text: "needs_information: anything" })).toBeNull();
    expect(judge.satisfierDeclineClass(null)).toBeNull();
    expect(judge.satisfierDeclineClass("needs_information: x")).toBeNull();
  });

  test("an undeclined capture keeps its recorded keys (no declined key)", () => {
    const cap = creditOnHollowInput({ templateId: "satisfier:memoryNote_write", verdict: { deterministic: false, reason: null }, consumedInChain: 0, editEffectReach: null, lastPickProducedJudgedArtifact: true, noOracle: false });
    expect("declined" in cap).toBe(false);
  });
});
