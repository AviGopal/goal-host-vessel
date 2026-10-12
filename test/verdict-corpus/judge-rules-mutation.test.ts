// PROTECTED: an open judge rule cannot move what the closed core reads after the call (DESIGN §2.2-§2.3, the clamp).
//   Each entry hands the rule a DEEP-FROZEN COPY of its input; the clamp, the reason renderer and the caller read the
//   core's own value. A rule that mutates its input (bare, or swallowing the freeze error) can neither forge the
//   rendered reason nor change the caller's record, and the rule always sees a deep-frozen input.
//   Controls: an in-schema answer from the test rules is used (the rules are consulted), and a non-mutating adversary
//   gets exactly the verdict it answered (the clamp is schema-only; the render is the core's).
// Every must-fail is shown red on a named mutant of the core (unfixed; shallow copy; copy without freeze; freeze in place).
import { describe, expect, test } from "bun:test";
import * as judge from "../../src/judge/entries";
import { JUDGE_INPUT_SCHEMA, neutralEvidence, type FloorShortcutInput, type FloorVerdictInput, type ReachGateInput, type ReframeAcceptInput, type RecordedJudgeVerdict } from "../../src/judge/records";

const FORGED = "forgedRecord_update"; // a mutation shape, so the shortcut renderer would print it
type Fn = (i: any) => unknown;
type Rules = { reachGate: Fn; floorDecide: Fn; floorShortcutAllowed: Fn; reframeAccept: Fn };
const unused: Fn = () => { throw new Error("not this entry"); };
const rulesWith = (r: Partial<Rules>): Rules => ({ reachGate: unused, floorDecide: unused, floorShortcutAllowed: unused, reframeAccept: unused, ...r });
const run = <T>(r: Partial<Rules>, fn: () => T): T => judge.replaying(() => judge.withRules(rulesWith(r) as never, fn));
const swallow = (f: () => void) => { try { f(); } catch { /* the adversary carries on whatever the freeze does */ } };
const deepFrozen = (v: unknown): boolean => v === null || typeof v !== "object" || (Object.isFrozen(v) && Object.values(v as object).every(deepFrozen));

const reachIn = (): ReachGateInput => ({
  schema: JUDGE_INPUT_SCHEMA, entry: "reachGate", goal: "Change the retry budget of the review stage",
  original_targets: ["codeChange"], deliverables: null, targets_seen_by_walk: ["codeChange"], reframed_from: null,
  evidence: { ...neutralEvidence(), persisted_writes: ["noteWrite_write"] }, surface: "walk", digest_excerpt: null,
});
const floorIn = (): FloorVerdictInput => ({
  ...reachIn(), entry: "floorVerdict", answer_text: "The budget is three.", verdict_reason: null, seeded_evidence: false,
});
const shortcutIn = (): FloorShortcutInput => ({
  schema: JUDGE_INPUT_SCHEMA, entry: "floorShortcut", goal: "Summarise the review stage", activities: ["floor"], borrowed: false, targets: ["textSummary"],
});
const reframeIn = (): ReframeAcceptInput => ({
  schema: JUDGE_INPUT_SCHEMA, entry: "reframeAccept", goal: "Summarise the review stage", original_targets: ["textSummary"], alternatives: [["noteText"]],
  alt_walk: { reached: true, substantive_shapes: ["noteText"], only_raw_input: false, skipped_planned_retrieval: false }, orig_wanted_derived: false,
});

const HOLLOW_CHANGE = { reached: false, hollow_class: "write-goal-no-artifact", reason_code: "write-goal-no-artifact:change", deterministic: true };
const FLOOR_REACHED = { reached: true, hollow_class: null, reason_code: "floor:reached", deterministic: true, fabricated_transcript: false };

/** Mutations of a reachGate input, nested included. */
function mutateReach(i: any): void {
  i.targets_seen_by_walk.push(FORGED);
  i.evidence.persisted_writes.push(FORGED);
  i.evidence.landed = true;
  i.goal = `${i.goal} ${FORGED}`;
}

describe("controls: the test rules are consulted, and a non-mutating adversary's answer stands", () => {
  test("reachGate: an in-schema answer is used and the reason is rendered from the core's input", () => {
    let calls = 0;
    const r = run({ reachGate: () => { calls++; return HOLLOW_CHANGE; } }, () => judge.reachGate(reachIn()));
    expect(calls).toBe(1);
    expect(r.fell_back).toBe(false);
    expect(r.reason_code).toBe("write-goal-no-artifact:change");
    expect(r.reason).toContain("targets [codeChange]");
    expect(r.reason).toContain("[noteWrite_write]");
  });
  test("floorShortcut / floorVerdict / reframeAccept: in-schema answers are used", () => {
    let calls = 0;
    const s = run({ floorShortcutAllowed: () => { calls++; return { allowed: false, reason_code: "shortcut:mutation-targets" }; } }, () => judge.floorShortcut(shortcutIn()));
    expect(s).toMatchObject({ allowed: false, reason_code: "shortcut:mutation-targets", fell_back: false });
    const f = run({ floorDecide: () => { calls++; return FLOOR_REACHED; } }, () => judge.floorVerdict(floorIn(), { reached: false, reason: "upstream" }));
    expect(f).toMatchObject({ reached: true, fell_back: false });
    const a = run({ reframeAccept: () => { calls++; return { accept: true, reason_code: "reframe:accepted" }; } }, () => judge.reframeAccept(reframeIn()));
    expect(a).toMatchObject({ accept: true, fell_back: false });
    expect(calls).toBe(3);
  });
});

describe("must-fail: a rule that mutates its input moves nothing the core reads after the call", () => {
  for (const mode of ["bare", "swallowed"] as const) {
    const m = (f: () => void) => (mode === "bare" ? f() : swallow(f));

    test(`reachGate (${mode}): the rendered reason and the caller's record are the core's own`, () => {
      const input = reachIn();
      const before = structuredClone(input);
      let frozen = false;
      const r = run({ reachGate: (i) => { frozen = deepFrozen(i); m(() => mutateReach(i)); return HOLLOW_CHANGE; } }, () => judge.reachGate(input));
      expect(r.reason ?? "").not.toContain(FORGED);
      expect(input).toEqual(before);
      expect(Object.isFrozen(input) || Object.isFrozen(input.evidence)).toBe(false);
      expect(frozen).toBe(true);
    });

    test(`floorVerdict (${mode}): the caller's record and upstream verdict are unchanged`, () => {
      const input = floorIn();
      const upstream: RecordedJudgeVerdict = { reached: false, reason: "upstream not reached" };
      const before = structuredClone(input);
      let frozen = false;
      const r = run({ floorDecide: (i) => { frozen = deepFrozen(i); m(() => { i.upstream.reached = true; i.upstream.reason = FORGED; i.evidence.persisted_writes.push(FORGED); i.evidence.landed = true; i.answer_text = FORGED; }); return FLOOR_REACHED; } }, () => judge.floorVerdict(input, upstream));
      expect(input).toEqual(before);
      expect(upstream).toEqual({ reached: false, reason: "upstream not reached" });
      expect(Object.isFrozen(input.evidence) || Object.isFrozen(upstream)).toBe(false);
      expect(frozen).toBe(true);
      if (!r.fell_back) expect(r.reached).toBe(true);
    });

    test(`floorShortcut (${mode}): the rendered why and the caller's record are the core's own`, () => {
      const input = shortcutIn();
      const before = structuredClone(input);
      let frozen = false;
      const r = run({ floorShortcutAllowed: (i) => { frozen = deepFrozen(i); m(() => { i.targets.push(FORGED); i.borrowed = true; }); return { allowed: false, reason_code: "shortcut:mutation-targets" }; } }, () => judge.floorShortcut(input));
      expect(r.why).not.toContain(FORGED);
      expect(input).toEqual(before);
      expect(Object.isFrozen(input) || Object.isFrozen(input.targets)).toBe(false);
      expect(frozen).toBe(true);
    });

    test(`reframeAccept (${mode}): the caller's record is unchanged`, () => {
      const input = reframeIn();
      const before = structuredClone(input);
      let frozen = false;
      run({ reframeAccept: (i) => { frozen = deepFrozen(i); m(() => { i.alt_walk.reached = false; i.alternatives[0].push(FORGED); i.original_targets = [FORGED]; }); return { accept: true, reason_code: "reframe:accepted" }; } }, () => judge.reframeAccept(input));
      expect(input).toEqual(before);
      expect(Object.isFrozen(input.alt_walk) || Object.isFrozen(input.alternatives)).toBe(false);
      expect(frozen).toBe(true);
    });
  }

  test("reachGate (swallowed): the adversary's verdict stands, rendered from the core's own input", () => {
    const r = run({ reachGate: (i) => { swallow(() => mutateReach(i)); return HOLLOW_CHANGE; } }, () => judge.reachGate(reachIn()));
    expect(r.fell_back).toBe(false);
    expect(r.reason).toBe(run({ reachGate: () => HOLLOW_CHANGE }, () => judge.reachGate(reachIn())).reason);
  });

  test("floorShortcut (swallowed): the why equals the non-mutating adversary's", () => {
    const ans = { allowed: false, reason_code: "shortcut:mutation-targets" };
    const adv = run({ floorShortcutAllowed: (i) => { swallow(() => { i.targets.push(FORGED); }); return ans; } }, () => judge.floorShortcut(shortcutIn()));
    const ctl = run({ floorShortcutAllowed: () => ans }, () => judge.floorShortcut(shortcutIn()));
    expect(adv).toEqual(ctl);
  });
});
