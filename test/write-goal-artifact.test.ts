// A WRITE OR CHANGE GOAL IS REACHED BY AN ARTIFACT, NEVER BY PROSE (the rules: src/judge-rules/write-goal.ts and
// src/judge-rules/floor.ts; the closed floor clamps: src/judge/floor-clamps.ts; the closed adapters that render the
// reason text: src/judge/entries.ts).
//
// The class: the floor's reached runs produced no shape, persisted no write and landed no sha, yet were graded
// reached on text, and a write shape stored as such a path's endpoint let REUSE-BEFORE-DERIVE lend the "proven"
// floor to later write goals. The fixtures below are class paraphrases: a pathless imperative asking the system to
// change its own behaviour, judged on a plan; and a mechanism-change goal judged on a prose note.
import { describe, expect, test } from "bun:test";
import {
  artifactWrites,
  goalAsksForBehaviourChange,
  goalAsksForChange,
  goalRequiresArtifact,
  writeGoalArtifactGate,
} from "../src/judge-rules/write-goal";
import { shortcutAllowed } from "../src/judge-rules/floor";
import { claimsWriteSucceeded, floorCompletionShapes, zeroToolWriteClaim } from "../src/judge/floor-clamps";
import * as judge from "../src/judge/entries";
import { reachInput, shortcutInput } from "../src/judge/inputs";
import { JUDGE_INPUT_SCHEMA, neutralEvidence, type ReachGateInput } from "../src/judge/records";

const MECHANISM_CHANGE_GOAL = "Some learned procedures fail every time, the failures are already on record, and they are still chosen first. Make that record stop them being chosen, and let selection fall back to a procedure that works.";
const STALL_NOTICE_GOAL = "A queue of the system's own work items can stop moving at any stage and nothing notices except a person reading logs. Make the system notice by itself when a stage stops advancing and treat that as a work item of its own. Whatever it adds must fire on flow stopping, not on backlog size.";
const PLAN_FINAL_TEXT = "Plan: stamp each item with a last-advanced time, add a stall detector, and raise a stall item. Since I cannot see the output, the write to substrateGap_write was most likely successful. I have shown how such a stall item would be raised.";
const PLAN_REASON = "The plan covers each part of the request with a progress stamp, a stall detector and a new kind of item raised automatically.";
const shortcut = (goal: string, activities: string[], borrowed: boolean, targets: string[]) => shortcutAllowed(shortcutInput({ goal, activities, borrowed, targets }));

describe("change/write intent reuses goal-intent and adds only a sentence-initial imperative", () => {
  test("a mechanism-change goal and a stall-notice goal ask for a change in behaviour (neither names a path or a code word)", () => {
    expect(goalAsksForBehaviourChange(MECHANISM_CHANGE_GOAL)).toBe(true);
    expect(goalAsksForBehaviourChange(STALL_NOTICE_GOAL)).toBe(true);
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
      "Is there an open gap for the stalled review stage?",
      "Write three interview questions for a backend engineering role",
      "Write a summary of today's failing tests in goal-host-vessel.",
    ]) expect([g, goalAsksForChange(g)]).toEqual([g, false]);
  });
  test("write/create/file lead a persist instruction only with a stored-thing object", () => {
    expect(goalAsksForChange("File a gap recording that the review stage has not advanced in six hours.")).toBe(true);
    expect(goalAsksForChange("Write ONE failing test that reproduces the defect in the gap store's retention sweep.")).toBe(true);
  });
  test("a mutation-shape target alone is write intent", () => {
    expect(goalRequiresArtifact("Is the lane stalled", ["substrateGap_write"])).toBe(true);
    expect(goalRequiresArtifact("Is the lane stalled", ["gap_lifecycle_scan"])).toBe(false);
  });
});

describe("item 1: a change/write goal counts as reached only with an artifact", () => {
  test("(a) reach via a prose concept_write + an unrelated policy writeback for a mechanism change -> HOLLOW", () => {
    const g = writeGoalArtifactGate(MECHANISM_CHANGE_GOAL, { persistedWrites: ["concept_write", "learningPolicyWriteback"], targets: ["concept_write", "posteriorCompensation"], postReachSink: true });
    expect(g.hollow).toBe(true);
    expect(artifactWrites(MECHANISM_CHANGE_GOAL, { persistedWrites: ["concept_write", "learningPolicyWriteback"], targets: ["concept_write", "posteriorCompensation"] })).toEqual([]);
  });
  test("(b) the floor, tools 0/0, targets [substrateGap_write, gap_lifecycle_scan], no write -> HOLLOW, and the core renders the reason", () => {
    const g = writeGoalArtifactGate(STALL_NOTICE_GOAL, { persistedWrites: [], targets: ["substrateGap_write", "gap_lifecycle_scan"] });
    expect(g.hollow).toBe(true);
    const targets = ["substrateGap_write", "gap_lifecycle_scan"];
    const v = judge.reachGate(reachInput({ goal: STALL_NOTICE_GOAL, writeEvidence: { persistedWrites: [], targets }, targets, landed: false }));
    expect(v.hollow).toBe(true);
    expect(v.reason).toBe("deterministic:write-goal-no-artifact — the goal asks for a change (targets [substrateGap_write, gap_lifecycle_scan]), and a change/write goal is reached only by a landed sha or a persisted write of its own target; this run persisted no write and landed nothing, so a plan or prose answer cannot reach it");
  });
  test("an unrelated write does not count when the goal's targets are known", () => {
    expect(writeGoalArtifactGate(STALL_NOTICE_GOAL, { persistedWrites: ["goal_verification_label_write"], targets: ["substrateGap_write"] }).hollow).toBe(true);
  });
  test("NEGATIVE CONTROL: a write goal with a real persisted write of its own target reaches", () => {
    expect(writeGoalArtifactGate("File a gap recording that the review stage stalled.", { persistedWrites: ["substrateGap_write"], targets: ["substrateGap_write"] }).hollow).toBe(false);
    expect(writeGoalArtifactGate(STALL_NOTICE_GOAL, { persistedWrites: ["substrateGap_write"], targets: ["substrateGap_write", "gap_lifecycle_scan"] }).hollow).toBe(false);
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

describe("item 1b: a re-framed walk is judged on the goal's own targets, unfiltered", () => {
  // A record goal re-framed from its own target (concept_write) to a memory note: the class of corpus case 0005.
  const RECORD_GOAL = "Keep what was learned from yesterday's broken deploy as a concept in the graph.";
  const reframed = (persisted: string[], over: Partial<ReachGateInput> = {}): ReachGateInput => ({
    schema: JUDGE_INPUT_SCHEMA, entry: "reachGate", goal: RECORD_GOAL,
    original_targets: ["concept_write"], deliverables: null, targets_seen_by_walk: ["memoryNote_write"], reframed_from: ["concept_write"],
    evidence: { ...neutralEvidence(), persisted_writes: persisted, post_reach_sink: true },
    surface: "walk", digest_excerpt: null, ...over,
  });
  test("a write of the re-framed target only -> HOLLOW reframed-target, deterministic, and the core renders the reason", () => {
    const v = judge.reachGate(reframed(["memoryNote_write"]));
    expect([v.hollow, v.hollow_class, v.reason_code, v.deterministic, v.fell_back]).toEqual([true, "reframed-target", "reframed-target", true, false]);
    expect(v.reason).toBe("deterministic:reframed-target — the walk was re-framed from [concept_write] and reached only a re-framed target; the goal's own target was never produced");
    expect(judge.reachGate(reframed([])).hollow_class).toBe("reframed-target");
  });
  test("NEGATIVE CONTROL: the re-framed walk persisted the ORIGINAL target, or landed -> not hollowed here", () => {
    expect(judge.reachGate(reframed(["concept_write"])).hollow).toBe(false);
    expect(judge.reachGate(reframed(["memoryNote_write", "concept_write"])).hollow).toBe(false);
    expect(judge.reachGate(reframed([], { evidence: { ...neutralEvidence(), landed: true, post_reach_sink: true } })).hollow).toBe(false);
  });
  test("NEGATIVE CONTROL: no re-framing, or a re-framed read goal with no mutation target, is left to the existing gate", () => {
    expect(judge.reachGate(reframed(["memoryNote_write"], { reframed_from: null })).hollow).toBe(false);
    expect(judge.reachGate(reframed([], { goal: "Summarise what changed in the walk budget over the last week", original_targets: ["summary_report"], reframed_from: ["summary_report"], targets_seen_by_walk: ["llm_completion"] })).hollow).toBe(false);
  });
});

describe("item 2: a write/call success claim with zero tools and zero writes is hollow by construction", () => {
  test("(b) a plan text claiming a write and (c) a generic 0-tool claim are claims", () => {
    expect(claimsWriteSucceeded(PLAN_FINAL_TEXT)).toBe(true);
    expect(claimsWriteSucceeded("There was no gap, so I created one: the substrateGap_write call succeeded and the gap is now open.")).toBe(true);
    expect(claimsWriteSucceeded("I have successfully filed the gap.")).toBe(true);
  });
  test("(b)/(c) with tools 0/0 and no write -> hollow; the verdict's own reason counts too", () => {
    expect(zeroToolWriteClaim([PLAN_FINAL_TEXT, PLAN_REASON], { toolsTotal: 0, writes: 0 })).toBe(true);
    expect(zeroToolWriteClaim(["prose", "I created the gap and the write was successful"], { toolsTotal: 0, writes: 0 })).toBe(true);
  });
  test("NEGATIVE CONTROL: the same claim with a real write, or tools run, is not refused here", () => {
    expect(zeroToolWriteClaim([PLAN_FINAL_TEXT], { toolsTotal: 1, writes: 1 })).toBe(false);
    expect(zeroToolWriteClaim([PLAN_FINAL_TEXT], { toolsTotal: 2, writes: 0 })).toBe(false);
    expect(zeroToolWriteClaim([PLAN_FINAL_TEXT], { toolsTotal: 0, writes: 0, outputImpulses: 1 })).toBe(false);
  });
  test("NEGATIVE CONTROL: an honest answer that claims no write is not a claim", () => {
    for (const t of [
      "Sunlight scatters off air molecules; shorter blue wavelengths scatter most (Rayleigh scattering), so the sky looks blue.",
      "Without live data: used Gen 9 units typically list between $350 and $500.",
      PLAN_REASON,
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
  test("(e) borrowed floor (shape-signature donor) for a change goal -> refused", () => {
    const r = shortcut(STALL_NOTICE_GOAL, ["universal-tool-fallback"], true, ["gap_lifecycle_scan"]);
    expect(r.allowed).toBe(false);
  });
  test("(e) a *_write target is a durable artifact: refused even on the goal's own path", () => {
    expect(shortcut("Is the lane stalled", ["universal-tool-fallback"], false, ["substrateGap_write"]).allowed).toBe(false);
  });
  test("(e) NEGATIVE CONTROL: the goal's OWN floor path for a read goal is still reused", () => {
    expect(shortcut("Explain why the sky looks blue during the day", ["universal-tool-fallback"], false, ["llm_completion_dispatch"]).allowed).toBe(true);
  });
  test("edit and durable-artifact goals keep their existing refusal; a longer path is never the shortcut", () => {
    expect(shortcut("Add X to repos/goal-host-vessel/src/quiesce.ts", ["universal-tool-fallback"], false, []).allowed).toBe(false);
    expect(shortcut("Write a note recording the findings", ["universal-tool-fallback"], false, []).allowed).toBe(false);
    expect(shortcut("Explain why the sky looks blue", ["satisfier:x", "universal-tool-fallback"], false, []).allowed).toBe(false);
  });
});
