// Pins isGapRepairGoal: the gap-lifecycle loop's own standing repair-attempt phrasing
// ("Close substrate gap <id>: <description>") demands landing evidence just like any
// other code-change ask, even though it uses verbs (close/author/resolve) that
// isPathlessCodeChangeGoal's MUTATION_VERB list does not recognise.
//
// THE DEFECT (2026-08-28), reproduced live TWICE the same session:
//   1. goal_hash=8b3afc7c ("Close substrate gap systematic-failure-universal-tool-fallback-zero:
//      ...author an improvement so it reaches.") — feature_compose timed out, no producer
//      for code_modification_proposal, the walk correctly filed its own capability gap —
//      then the floor still reached:true (groundedOk=0) on an LLM narration claiming
//      "Implemented a targeted fix..." with zero fs_edit and zero goal_verification_label.
//   2. goal_hash=16cb4a28 ("Close substrate gap close-gap-repair-goals-confabulate-fixed...")
//      — a repair attempt on the gap describing THIS EXACT DEFECT reproduced it: inferred
//      target shapes were empty (confidence 0), no code fix was ever attempted, and the
//      floor still reached:true on bare narration.
// Root cause: goalDemandsLandedEdit gates on isPathlessCodeChangeGoal, whose MUTATION_VERB
// list has no "close", "author", or "resolve" — so this entire goal class never reached the
// landing-evidence check at all.
import { describe, expect, test } from "bun:test";
import { isGapRepairGoal } from "./goal-intent";

describe("isGapRepairGoal — the gap-lifecycle loop's repair-attempt phrasing", () => {
  test("recognises the exact live autonomous phrasing (both observed instances)", () => {
    expect(isGapRepairGoal(
      "Close substrate gap systematic-failure-universal-tool-fallback-zero: Capability " +
      "\"universal-tool-fallback\" fails systematically at task \"(no tasks)\" (0/0 tasks ok, " +
      "failure_mode: unknown) across 3 recent traces — author an improvement so it reaches.",
    )).toBe(true);
    expect(isGapRepairGoal(
      "Close substrate gap orphaned-capability-eventStream: Resolver never wires eventStream " +
      "to a live consumer.",
    )).toBe(true);
  });

  test("does not misfire on an investigation goal (a different, already-grounded class)", () => {
    expect(isGapRepairGoal("investigate and decompose gap narrowing-a-chronically-stuck-gap")).toBe(false);
  });

  test("does not misfire on an unrelated report or explanation ask", () => {
    expect(isGapRepairGoal("Report how many gaps are currently open in the gap store.")).toBe(false);
    expect(isGapRepairGoal("Explain why the discovery registry tracks vessel health.")).toBe(false);
  });

  test("undefined and empty are handled", () => {
    expect(isGapRepairGoal(undefined)).toBe(false);
    expect(isGapRepairGoal("")).toBe(false);
  });
});
