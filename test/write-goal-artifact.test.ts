// A WRITE OR CHANGE GOAL IS REACHED BY AN ARTIFACT, NEVER BY PROSE (src/write-goal-artifact.ts).
//
// Measured: the floor's 36 reached=true runs over ~5 days produced 0 shapes, persisted 0 writes and
// landed 0 shas; 17 of them stored a write shape as the path's endpoint output, and REUSE-BEFORE-DERIVE
// then lent that "proven" floor to later write goals. The fixtures below are reconstructed from the two
// recorded instances (N5: execution universal-tool-fallback-c154c685-1791710679359; N10: dispatch
// 0f03761a). The index.ts wiring of each rule is pinned by the verdict-diff scenarios
// n10-shaped-mechanism-change-prose-concept, n5-shaped-floor-*, floor-zero-tool-write-claim-question,
// floor-read-reach-records-produced-shapes-only and shortcut-*.
import { describe, expect, test } from "bun:test";
import {
  artifactWrites,
  claimsWriteSucceeded,
  floorCompletionShapes,
  floorShortcutAllowed,
  goalAsksForBehaviourChange,
  goalAsksForChange,
  goalRequiresArtifact,
  writeGoalArtifactGate,
  zeroToolWriteClaim,
} from "../src/write-goal-artifact";

const N10_GOAL = "Some of the system's learned procedures fail every time, and the evidence that they fail is already recorded, yet the system keeps choosing them. Make that evidence stop the system choosing them, and let it fall back to the way that works.";
const N5_GOAL = "The system's own improvement lane can stall at any stage — a gap waits to be armed, admitted, composed, landed, settled or reverted, and nothing advances — and nothing in the system notices; only an operator does. Make the system notice, by itself, when any stage of its own lane stops advancing, and treat that as its own gap. The lane's stages are recorded on each gap and in the lane's execution record; the system's existing joint observer already reads registered joints from the pool each tick, but it can only see open gaps, cannot ask 'has anything advanced recently', and no stage records why a gap was not admitted. Whatever the system adds must be data it writes itself where possible, and must fire on flow stopping, not on the size of the backlog.";
const N5_FINAL_TEXT = "Plan: augment each gap with a last_advanced_at stamp, add a stagnation detector, and file a 'stagnation' gap. Since I cannot see the output, it's likely that the actual call to substrateGap_write was successful. I have demonstrated how such a stagnation gap would be created.";
const N5_REASON = "The plan outlines a comprehensive system for detecting and reporting stalled progress in the system's own lane by augmenting gap data, adding a stagnation detection component, and automatically creating new 'stagnation' gaps, directly addressing all aspects of the prompt.";
const isFloor = (a: string) => a === "universal-tool-fallback";

describe("change/write intent reuses goal-intent and adds only a sentence-initial imperative", () => {
  test("N10 and N5 ask for a change in behaviour (neither names a path or a code word)", () => {
    expect(goalAsksForBehaviourChange(N10_GOAL)).toBe(true);
    expect(goalAsksForBehaviourChange(N5_GOAL)).toBe(true);
  });
  test("an edit goal naming a repos file is a change (isEditIntentGoal reused)", () => {
    expect(goalAsksForChange("Add a constant VERDICT_DIFF_MARKER to repos/goal-host-vessel/src/quiesce.ts that names the harness")).toBe(true);
  });
  test("questions and explanations are not changes, whatever verb sits inside them", () => {
    for (const g of [
      "Explain why the sky looks blue during the day",
      "Explain what makes the reach judge accept prose",
      "Why does the gate stop the walk?",
      "How many files changed in repos/goal-host-vessel/src last week?",
      "Is there an open gap for the stalled compose stage of the improvement lane?",
      "Write three interview questions for a backend engineering role",
      "Write a summary of today's failing tests in goal-host-vessel.",
    ]) expect([g, goalAsksForChange(g)]).toEqual([g, false]);
  });
  test("write/create/file lead a persist instruction only with a stored-thing object", () => {
    expect(goalAsksForChange("File a gap recording that the improvement lane's compose stage has not advanced in six hours.")).toBe(true);
    expect(goalAsksForChange("Write ONE failing test that reproduces the defect in the gap store's retention sweep.")).toBe(true);
  });
  test("a mutation-shape target alone is write intent", () => {
    expect(goalRequiresArtifact("Is the lane stalled", ["substrateGap_write"])).toBe(true);
    expect(goalRequiresArtifact("Is the lane stalled", ["gap_lifecycle_scan"])).toBe(false);
  });
});

describe("item 1: a change/write goal counts as reached only with an artifact", () => {
  test("(a) N10: reach via a prose concept_write + learningPolicyWriteback for a mechanism change -> HOLLOW", () => {
    const g = writeGoalArtifactGate(N10_GOAL, { persistedWrites: ["concept_write", "learningPolicyWriteback"], targets: ["concept_write", "posteriorCompensation"], postReachSink: true });
    expect(g.hollow).toBe(true);
    expect(artifactWrites(N10_GOAL, { persistedWrites: ["concept_write", "learningPolicyWriteback"], targets: ["concept_write", "posteriorCompensation"] })).toEqual([]);
  });
  test("(b) N5: the floor, tools 0/0, targets [substrateGap_write, gap_lifecycle_scan], no write -> HOLLOW", () => {
    const g = writeGoalArtifactGate(N5_GOAL, { persistedWrites: [], targets: ["substrateGap_write", "gap_lifecycle_scan"] });
    expect(g.hollow).toBe(true);
    if (g.hollow) expect(g.reason).toStartWith("deterministic:write-goal-no-artifact");
  });
  test("an unrelated write does not count when the goal's targets are known", () => {
    expect(writeGoalArtifactGate(N5_GOAL, { persistedWrites: ["goal_verification_label_write"], targets: ["substrateGap_write"] }).hollow).toBe(true);
  });
  test("NEGATIVE CONTROL: a write goal with a real persisted write of its own target reaches", () => {
    expect(writeGoalArtifactGate("File a gap recording that the compose stage stalled.", { persistedWrites: ["substrateGap_write"], targets: ["substrateGap_write"] }).hollow).toBe(false);
    expect(writeGoalArtifactGate(N5_GOAL, { persistedWrites: ["substrateGap_write"], targets: ["substrateGap_write", "gap_lifecycle_scan"] }).hollow).toBe(false);
  });
  test("NEGATIVE CONTROL: an edit goal with a landed sha reaches", () => {
    expect(writeGoalArtifactGate("Add a constant VERDICT_DIFF_MARKER to repos/goal-host-vessel/src/quiesce.ts", { persistedWrites: [], landed: true }).hollow).toBe(false);
  });
  test("NEGATIVE CONTROL: a read/question goal is not gated at all (its answer is the deliverable)", () => {
    expect(writeGoalArtifactGate("Explain why the sky looks blue during the day", { persistedWrites: [], targets: ["llm_completion_dispatch"] }).hollow).toBe(false);
    expect(writeGoalArtifactGate("Which file defines verifyGoalReached?", { persistedWrites: [], targets: ["codeSearchResult"] }).hollow).toBe(false);
  });
  test("a durable-record goal: the note write is its artifact; the walk's post-reach bridge is allowed to write it after the verdict", () => {
    const g = "Write a memory note recording the count of TypeScript files in repos/goal-host-vessel/src";
    expect(writeGoalArtifactGate(g, { persistedWrites: ["memoryNote_write"], targets: ["memoryNote_write"] }).hollow).toBe(false);
    expect(writeGoalArtifactGate(g, { persistedWrites: [], targets: ["memoryNote_write"], postReachSink: true }).hollow).toBe(false);
    expect(writeGoalArtifactGate(g, { persistedWrites: [], targets: ["memoryNote_write"] }).hollow).toBe(true);
  });
  test("NEGATIVE CONTROL: a vault question whose walk carries the bridge's note write as a terminal shape stays a question", () => {
    const g = "What is happening today? This should search the web for multiple sources, get the current date and recent month / year. Then produce a report with the main headlines and some commentary on each.";
    expect(writeGoalArtifactGate(g, { persistedWrites: [], targets: ["web_search", "llm_completion", "obsidian:write_note"], postReachSink: true }).hollow).toBe(false);
  });
  test("a note edit names a prose destination, so the note write IS its artifact", () => {
    expect(writeGoalArtifactGate("Update my notes with today's findings", { persistedWrites: ["write_note"], targets: [] }).hollow).toBe(false);
  });
});

describe("item 2: a write/call success claim with zero tools and zero writes is hollow by construction", () => {
  test("(b) N5's floor text and (c) a generic 0-tool claim are claims", () => {
    expect(claimsWriteSucceeded(N5_FINAL_TEXT)).toBe(true);
    expect(claimsWriteSucceeded("There was no gap, so I created one: the substrateGap_write call succeeded and the gap is now open.")).toBe(true);
    expect(claimsWriteSucceeded("I have successfully filed the gap.")).toBe(true);
  });
  test("(b)/(c) with tools 0/0 and no write -> hollow; the verdict's own reason counts too", () => {
    expect(zeroToolWriteClaim([N5_FINAL_TEXT, N5_REASON], { toolsTotal: 0, writes: 0 })).toBe(true);
    expect(zeroToolWriteClaim(["prose", "I created the gap and the write was successful"], { toolsTotal: 0, writes: 0 })).toBe(true);
  });
  test("NEGATIVE CONTROL: the same claim with a real write, or tools run, is not refused here", () => {
    expect(zeroToolWriteClaim([N5_FINAL_TEXT], { toolsTotal: 1, writes: 1 })).toBe(false);
    expect(zeroToolWriteClaim([N5_FINAL_TEXT], { toolsTotal: 2, writes: 0 })).toBe(false);
    expect(zeroToolWriteClaim([N5_FINAL_TEXT], { toolsTotal: 0, writes: 0, outputImpulses: 1 })).toBe(false);
  });
  test("NEGATIVE CONTROL: an honest answer that claims no write is not a claim", () => {
    for (const t of [
      "Sunlight scatters off air molecules; shorter blue wavelengths scatter most (Rayleigh scattering), so the sky looks blue.",
      "Without live data: used Gen 9 units typically list between $350 and $500.",
      N5_REASON,
      "I cannot write to the gap store from here; nothing was filed.",
    ]) expect([t, claimsWriteSucceeded(t)]).toEqual([t, false]);
  });
});

describe("item 3: the floor's completion shapes are what it produced, never what it was asked for", () => {
  test("(d) nothing produced -> no completion shapes, whatever the judge named or the goal requested", () => {
    expect(floorCompletionShapes(["substrateGap_write", "gap_lifecycle_scan"], [])).toEqual([]);
    expect(floorCompletionShapes(["llm_completion_dispatch"], [])).toEqual([]);
    expect(floorCompletionShapes(undefined, [])).toEqual([]);
  });
  test("a produced write survives; a judge-named shape survives only if produced", () => {
    expect(floorCompletionShapes(["substrateGap_write", "gap_lifecycle_scan"], ["substrateGap_write"])).toEqual(["substrateGap_write"]);
    expect(floorCompletionShapes([], ["memoryNote_write"])).toEqual(["memoryNote_write"]);
  });
});

describe("item 4: the floor shortcut never reuses a borrowed path for a change/write goal", () => {
  test("(e) N5: borrowed floor (shape-signature donor) for a change goal -> refused", () => {
    const r = floorShortcutAllowed({ goal: N5_GOAL, activities: ["universal-tool-fallback"], borrowed: true, targets: ["gap_lifecycle_scan"], isFloorId: isFloor });
    expect(r.allowed).toBe(false);
  });
  test("(e) a *_write target is a durable artifact: refused even on the goal's own path", () => {
    expect(floorShortcutAllowed({ goal: "Is the lane stalled", activities: ["universal-tool-fallback"], borrowed: false, targets: ["substrateGap_write"], isFloorId: isFloor }).allowed).toBe(false);
  });
  test("(e) NEGATIVE CONTROL: the goal's OWN floor path for a read goal is still reused", () => {
    expect(floorShortcutAllowed({ goal: "Explain why the sky looks blue during the day", activities: ["universal-tool-fallback"], borrowed: false, targets: ["llm_completion_dispatch"], isFloorId: isFloor }).allowed).toBe(true);
  });
  test("edit and durable-artifact goals keep their existing refusal; a longer path is never the shortcut", () => {
    expect(floorShortcutAllowed({ goal: "Add X to repos/goal-host-vessel/src/quiesce.ts", activities: ["universal-tool-fallback"], borrowed: false, targets: [], isFloorId: isFloor }).allowed).toBe(false);
    expect(floorShortcutAllowed({ goal: "Write a note recording the findings", activities: ["universal-tool-fallback"], borrowed: false, targets: [], isFloorId: isFloor }).allowed).toBe(false);
    expect(floorShortcutAllowed({ goal: "Explain why the sky looks blue", activities: ["satisfier:x", "universal-tool-fallback"], borrowed: false, targets: [], isFloorId: isFloor }).allowed).toBe(false);
  });
});
