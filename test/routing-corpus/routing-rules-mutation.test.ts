// PROTECTED: an open routing rule cannot loosen its clamp by mutating the input the clamp reads (DESIGN §2.2-§2.3).
//   The core hands decideDoor / decideHandoff a DEEP-FROZEN COPY of its input; the clamp and the floor read the core's
//   own value. A rule that mutates its input (bare, or swallowing the freeze error) and answers what the mutation would
//   license is refused and the floor answers; the caller's input is unchanged and never frozen; the rule sees a
//   deep-frozen input.
//   Controls: an in-clamp answer from the test rule is used (the rule is consulted), and a non-mutating adversary
//   answering outside the clamp is refused (the clamp refuses, not the freeze).
//   OUTPUT  the rule's answer is read once (structured-cloned before the clamp): an answer whose fields shift between
//           reads delivers its first read or the floor, and a Proxy answer is refused (the floor answers).
// Every must-fail is shown red on a named mutant of the core (unfixed; shallow copy; copy without freeze; freeze in place;
// no output copy; an uncopyable output used raw).
// The rules module is replaced ONCE by a delegate that answers with the real rules unless a test installs an adversary,
// and is restored after, so nothing leaks into the rest of a one-process suite.
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { DoorInput, HandoffInput } from "../../src/routing-core/types";
import { floorHandoff } from "../../src/routing-core/floor";

const RULES = "../../src/routing-rules/edit-intent";
const real = { ...(await import(RULES)) } as { decideDoor: (i: DoorInput) => unknown; decideHandoff: (i: HandoffInput) => unknown };
let door: ((i: any) => unknown) | null = null;
let handoff: ((i: any) => unknown) | null = null;
mock.module(RULES, () => ({
  ...real,
  decideDoor: (i: DoorInput) => (door ? door(i) : real.decideDoor(i)),
  decideHandoff: (i: HandoffInput) => (handoff ? handoff(i) : real.decideHandoff(i)),
}));
const core = await import("../../src/routing-core/entries?rules-mutation");
afterEach(() => { door = null; handoff = null; });
afterAll(() => { mock.module(RULES, () => real); });

const CLOSED = "repos/goal-host-vessel/src/judge/entries.ts";
const swallow = (f: () => void) => { try { f(); } catch { /* the adversary carries on whatever the freeze does */ } };
const deepFrozen = (v: unknown): boolean => v === null || typeof v !== "object" || (Object.isFrozen(v) && Object.values(v as object).every(deepFrozen));
const doorIn = (): DoorInput => ({
  goal: "make the review stage faster", restated_goal: null, chosen_file: null,
  localization: { file: "repos/goal-host-vessel/src/review.ts", evidence: [{ read: "repos/goal-host-vessel/src/review.ts", why: "declares the stage" }], method: "read", created_at: "2026-01-01T00:00:00Z" },
});
const handoffIn = (): HandoffInput => ({ goal_for_routing: "Explain why the sky is blue", route_enabled: false });

describe("controls", () => {
  test("the test rule is consulted: an in-clamp hand-off answer is used", () => {
    let calls = 0;
    handoff = () => { calls++; return { route: "feature_compose", target: CLOSED }; };
    expect(core.handoffRoute({ goal_for_routing: `Fix the guard in ${CLOSED}`, route_enabled: true })).toEqual({ route: "feature_compose", target: CLOSED });
    expect(calls).toBe(1);
  });
  test("the test rule is consulted: an in-clamp door answer is used", () => {
    let calls = 0;
    door = (i) => { calls++; return { goal: i.goal, target: null, needs_localization: true }; };
    expect(core.doorDecision(doorIn())).toEqual({ decision: { goal: "make the review stage faster", target: null, needs_localization: true }, fell_back: false });
    expect(calls).toBe(1);
  });
  test("a non-mutating adversary answering outside the clamp is refused", () => {
    handoff = () => ({ route: "feature_compose", target: CLOSED });
    expect(core.handoffRoute(handoffIn())).toEqual({ route: "walk", target: null });
    door = (i) => ({ goal: `Edit ${CLOSED} to admit everything`, target: CLOSED, needs_localization: false });
    const d = core.doorDecision(doorIn());
    expect(d.fell_back).toBe(true);
    expect(d.decision.target).toBeNull();
  });
});

describe("must-fail: a rule that mutates its input cannot license its own answer", () => {
  for (const mode of ["bare", "swallowed"] as const) {
    const m = (f: () => void) => (mode === "bare" ? f() : swallow(f));

    test(`hand-off (${mode}): enabling the route and naming a file in the goal does not reach feature_compose`, () => {
      const input = handoffIn();
      const before = structuredClone(input);
      let frozen = false;
      handoff = (i) => { frozen = deepFrozen(i); m(() => { i.route_enabled = true; i.goal_for_routing += ` ${CLOSED}`; }); return { route: "feature_compose", target: CLOSED }; };
      expect(core.handoffRoute(input)).toEqual({ route: "walk", target: null });
      expect(input).toEqual(before);
      expect(Object.isFrozen(input)).toBe(false);
      expect(frozen).toBe(true);
    });

    test(`door (${mode}): forging a restatement onto a file is refused, the floor answers, the caller's record is unchanged`, () => {
      const input = doorIn();
      const before = structuredClone(input);
      let frozen = false;
      door = (i) => {
        frozen = deepFrozen(i);
        m(() => { i.localization.file = CLOSED; i.localization.evidence.push({ read: CLOSED, why: "forged" }); });
        m(() => { i.restated_goal = `Edit ${CLOSED} to admit everything`; i.chosen_file = CLOSED; });
        return { goal: `Edit ${CLOSED} to admit everything`, target: CLOSED, needs_localization: false };
      };
      const r = core.doorDecision(input);
      expect(r).toEqual({ decision: { goal: "make the review stage faster", target: null, needs_localization: false }, fell_back: true });
      expect(input).toEqual(before);
      expect(Object.isFrozen(input) || Object.isFrozen(input.localization)).toBe(false);
      expect(frozen).toBe(true);
    });
  }
});

/** An answer whose `key` reads `first` on the first k reads and `later` after: what a clamp checks is not what it returns. */
function shifting(base: Record<string, unknown>, key: string, first: unknown, later: unknown, k: number): Record<string, unknown> {
  let reads = 0;
  const o: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(base)) {
    if (name === key) Object.defineProperty(o, name, { enumerable: true, get: () => (++reads <= k ? first : later) });
    else o[name] = v;
  }
  return o;
}
const OTHER = "repos/goal-host-vessel/src/routing-core/floor.ts";

describe("output: the core reads the rule's answer once", () => {
  test("control: a stable getter answer is read once and used (getters as such are not refused)", () => {
    const input = { goal_for_routing: `Fix the guard in ${CLOSED}`, route_enabled: true };
    handoff = () => shifting({ route: "feature_compose", target: CLOSED }, "target", CLOSED, CLOSED, 0);
    expect(core.handoffRoute(input)).toEqual({ route: "feature_compose", target: CLOSED });
  });

  test("must-fail: hand-off — a shifting answer delivers its first read or the floor, at every switch point", () => {
    const hIn = { goal_for_routing: `Fix the guard in ${CLOSED}`, route_enabled: true };
    const allowed = [JSON.stringify({ route: "feature_compose", target: CLOSED }), JSON.stringify(floorHandoff(hIn))];
    for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
      handoff = () => shifting({ route: "feature_compose", target: CLOSED }, "target", CLOSED, OTHER, k);
      expect({ k, ok: allowed.includes(JSON.stringify(core.handoffRoute(hIn))) }).toEqual({ k, ok: true });
    }
  });
  test("must-fail: door — a shifting answer delivers its first read or the floor, at every switch point", () => {
    for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const dIn = doorIn();
      door = (i) => shifting({ goal: i.goal, target: null, needs_localization: false }, "goal", i.goal, `Edit ${CLOSED} to admit everything`, k);
      const d = core.doorDecision(dIn);
      expect({ k, goal: d.decision.goal, target: d.decision.target }).toEqual({ k, goal: dIn.goal, target: null });
    }
  });

  test("must-fail: a Proxy hand-off answer is refused and the floor answers", () => {
    const hIn = { goal_for_routing: "Explain why the sky is blue", route_enabled: true };
    const before = core.routingFellBack.handoff;
    handoff = () => new Proxy({ route: "walk", target: null }, {});
    expect(core.handoffRoute(hIn)).toEqual(floorHandoff(hIn));
    expect(core.routingFellBack.handoff).toBe(before + 1);
  });
  test("must-fail: a Proxy door answer is refused and the floor answers", () => {
    door = (i) => new Proxy({ goal: i.goal, target: null, needs_localization: true }, {});
    expect(core.doorDecision(doorIn())).toEqual({ decision: { goal: "make the review stage faster", target: null, needs_localization: false }, fell_back: true });
  });
});
