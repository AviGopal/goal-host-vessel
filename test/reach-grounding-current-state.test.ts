import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as RG from "../src/reach-grounding";
import { judgeReach, type ReachJudgeInput } from "../src/reach-grounding";

// Namespace reads, so the file loads at the parent (where these exports do not exist) and its tests fail by name there.
const liveStateCue = (g: string): boolean => (RG as any).LIVE_STATE_CUES?.test(g) ?? true;
const isEmptyReadOutput = (t: string): boolean | undefined => (RG as any).isEmptyReadOutput?.(t);

// Gap: the reach judge credits an ungrounded LLM answer about LIVE state. Probe 1bcb864f asked for the three most
// recent commits to a vessel; the walk ran one no-input llm_completion_dispatch step (git_log was a recalled candidate,
// never run), the judge said reached, and the answer named commits hours stale. groundingPreGate rule 6
// (ungrounded-current-state) now refuses a live-state goal whose chain has no step that read state and returned
// non-empty output. The model stub is the measured failure: a judge that grades any coherent answer reached.
//
// Fixture goals other than the probe's own wording come from 5-word draws (draw-words.sh, 2026-10-26T15:48:35Z):
//   D1 dropout hazelnut blighted refreeze uncurious  -> explanatory control
//   D2 friday smugly disgrace driver humble          -> trigger words, not a live-state question
//   D3 enclosure wasabi whoops had matching          -> write control
//   D4 getaway briskness blob crusher agony          -> live-state question with no trigger word (structural, rule 5)

const NOW = new Date("2026-10-26T10:30:00.000Z");
const PROBE_GOAL = "Summarize what the three most recent commits to development-vessel changed and why.";
const STALE_ANSWER = "The three most recent commits are 1817b61f (tighten the memory consolidation window), d4ced566 (log the drafter's recall size) and an earlier docs fix.";
const CODE = "deterministic:ungrounded-current-state — ungrounded: no step read the current state the goal asks about";

function rubberStamp(reached = true) {
  const prompts: string[] = [];
  const complete = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return JSON.stringify({ reached, reason: "the answer addresses the goal", completion_shapes: ["llm_completion_dispatch"] });
  };
  return { complete, prompts };
}

const envelope = (text: string, executed_tool_calls?: unknown[]) =>
  JSON.stringify({ success: true, shape: "llmTextCompletion", body: { text, model: "some-model", requested_model: "auto", ...(executed_tool_calls ? { executed_tool_calls } : {}) } });

/** The probe's chain: ∅ -> llm_completion_dispatch, one step, no inputs. */
function llmOnly(goal: string, answer: string, calls?: unknown[]): ReachJudgeInput {
  return {
    goal,
    producedShapes: ["goal", "dispatch_id", "llm_completion_dispatch"],
    taskSummary: "1 step: llm_completion_dispatch",
    contentDigest: `- llm_completion_dispatch: ${envelope(answer, calls)}`,
    commandEvidence: `- llm_completion_dispatch was produced by RUNNING: \`(no command field; resolve args) prompt=${goal}\``,
    now: NOW,
  };
}

/** A git_log read feeding the answer; `log` is the read's digest text. */
function gitLogThenLlm(goal: string, log: string, answer: string): ReachJudgeInput {
  return {
    goal,
    producedShapes: ["goal", "dispatch_id", "git_log", "llm_completion_dispatch"],
    taskSummary: "2 steps: git_log -> llm_completion_dispatch",
    contentDigest: `- git_log: ${log}\n- llm_completion_dispatch: ${envelope(answer)}`,
    now: NOW,
  };
}

const LOG = JSON.stringify({ success: true, body: { commits: [
  { sha: "720908c5", date: "2026-10-26T07:45:00Z", subject: "fix(memory): consolidate on session end" },
  { sha: "6b1e02aa", date: "2026-10-26T07:12:00Z", subject: "test(drafter): pin the recall window" },
  { sha: "3fd9c410", date: "2026-10-26T06:58:00Z", subject: "fix(gap): close on landed effect" },
] } });
const GROUNDED_ANSWER = "720908c5 consolidates memory on session end; 6b1e02aa pins the drafter's recall window; 3fd9c410 closes a gap on its landed effect.";

describe("rule 6: a live-state goal needs a step that read the state", () => {
  it("MF: the probe goal answered by one no-input llm step is not reached, with the named reason, and the judge is not asked", async () => {
    const j = rubberStamp();
    const v = await judgeReach(llmOnly(PROBE_GOAL, STALE_ANSWER), j.complete);
    expect(v?.reached).toBe(false);
    expect(v?.deterministic).toBe(true);
    expect(v?.reason.startsWith(CODE)).toBe(true);
    expect(j.prompts.length).toBe(0);
  });

  it("MF2: the same goal with a git_log step that returned commits feeding the answer is reached (the judge decides)", async () => {
    const j = rubberStamp();
    const v = await judgeReach(gitLogThenLlm(PROBE_GOAL, LOG, GROUNDED_ANSWER), j.complete);
    expect(v?.reached).toBe(true);
    expect(j.prompts.length).toBe(1);
  });

  it("a git_log read that ran but returned no commits does not ground it", async () => {
    for (const empty of [JSON.stringify({ success: true, body: { commits: [] } }), "[]", JSON.stringify({ success: false, error: "not a git repository" }), JSON.stringify({ stdout: "", exitCode: 0 })]) {
      const j = rubberStamp();
      const v = await judgeReach(gitLogThenLlm(PROBE_GOAL, empty, STALE_ANSWER), j.complete);
      expect(v?.reached).toBe(false);
      expect(v?.reason.startsWith(CODE)).toBe(true);
      expect(j.prompts.length).toBe(0);
    }
  });

  it("a tool the answering model ran itself grounds it only when it returned something", async () => {
    const ran = await judgeReach(llmOnly(PROBE_GOAL, GROUNDED_ANSWER, [{ name: "git_log", tool_output: "720908c5 fix(memory): consolidate on session end\n6b1e02aa test(drafter): pin the recall window" }]), rubberStamp().complete);
    expect(ran?.reached).toBe(true);
    const emptyRun = await judgeReach(llmOnly(PROBE_GOAL, STALE_ANSWER, [{ name: "git_log", tool_output: "" }]), rubberStamp().complete);
    expect(emptyRun?.reached).toBe(false);
    expect(emptyRun?.reason.startsWith(CODE)).toBe(true);
    const failed = await judgeReach(llmOnly(PROBE_GOAL, STALE_ANSWER, [{ name: "git_log", error: "exit 128", tool_output: "fatal: not a git repository" }]), rubberStamp().complete);
    expect(failed?.reached).toBe(false);
  });

  it("a registry read in the command evidence grounds a live-state goal", async () => {
    const v = await judgeReach({ ...llmOnly(PROBE_GOAL, GROUNDED_ANSWER), commandEvidence: "- shellResult was produced by RUNNING: `curl -s http://discovery/registry/shapes`" }, rubberStamp().complete);
    expect(v?.reached).toBe(true);
  });
});

describe("controls: what rule 6 leaves alone", () => {
  it("D1: an explanatory question answered by one llm step is unaffected", async () => {
    const j = rubberStamp();
    const v = await judgeReach(llmOnly(
      "Explain why hazelnut orchards blighted by a hard refreeze often drop out of production for years.",
      "A refreeze after bud break kills the catkins and young wood, and blight enters through the damage, so trees take several seasons to recover.",
    ), j.complete);
    expect(v?.reached).toBe(true);
    expect(j.prompts.length).toBe(1);
  });

  it("D2: a goal that uses the trigger words but asks nothing about live state is unaffected", async () => {
    const goal = "Now explain, as a humble fable, why the most recent ice age ended in disgrace for a smug Friday driver.";
    expect(liveStateCue(goal)).toBe(false);
    const j = rubberStamp();
    const v = await judgeReach(llmOnly(goal, "Once a smug driver raced the glaciers every Friday; when the ice retreated he was left stranded, and learned humility."), j.complete);
    expect(v?.reached).toBe(true);
    expect(j.prompts.length).toBe(1);
  });

  it("D3: a write goal answered by a write step is unaffected", async () => {
    const j = rubberStamp();
    const v = await judgeReach({
      goal: "Write a note called wasabi-enclosure.md saying whoops, the matching lids had gone missing.",
      producedShapes: ["goal", "dispatch_id", "fs_write"],
      taskSummary: "1 step: fs_write",
      contentDigest: `- fs_write: ${JSON.stringify({ success: true, path: "wasabi-enclosure.md", bytes: 47 })}`,
      now: NOW,
    }, j.complete);
    expect(v?.reached).toBe(true);
    expect(j.prompts.length).toBe(1);
  });

  it("D4: a live-state question with no trigger word is caught structurally (rule 5, its own code), not by the cue list", async () => {
    const goal = "Which vessels on this substrate serve the blob and crusher shapes the getaway plan depends on?";
    expect(liveStateCue(goal)).toBe(false);
    const refused = await judgeReach({ ...llmOnly(goal, "The blob-store and crusher vessels serve them."), localTargets: ["shape_producer_inventory"] }, rubberStamp().complete);
    expect(refused?.reached).toBe(false);
    expect(refused?.reason.startsWith("deterministic:unsourced-local-state")).toBe(true);
    const read = await judgeReach({
      goal,
      producedShapes: ["goal", "dispatch_id", "shape_producer_inventory", "llm_completion_dispatch"],
      taskSummary: "2 steps: shape_producer_inventory -> llm_completion_dispatch",
      contentDigest: `- shape_producer_inventory: ${JSON.stringify({ producers: [{ shape: "blob", vessel: "local-tools-vessel" }] })}\n- llm_completion_dispatch: ${envelope("local-tools-vessel serves blob; nothing serves crusher.")}`,
      localTargets: ["shape_producer_inventory"],
      now: NOW,
    }, rubberStamp().complete);
    expect(read?.reached).toBe(true);
  });

  it("a zero count is a value, not an empty read; a store listing with no entries is empty", () => {
    expect(isEmptyReadOutput(JSON.stringify({ count: 0, files: [] }))).toBe(false);
    expect(isEmptyReadOutput("0")).toBe(false);
    expect(isEmptyReadOutput(JSON.stringify({ status: "running" }))).toBe(false);
    expect(isEmptyReadOutput(JSON.stringify({ success: true, content: JSON.stringify({ total: 0, offset: 0, limit: 100, entries: [] }) }))).toBe(true);
    expect(isEmptyReadOutput("   ")).toBe(true);
  });
});

describe("the named reason is what the trace records", () => {
  // index.ts boots the host on import, so the persistence seam is pinned at its source: a walk that ends unreached
  // persists its verdict's reason verbatim as metadata.reach_reason (persistFailedWalkTrace), and the floor's trace does
  // the same, so "not reached: ungrounded-current-state" is countable apart from other misses.
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
  it("the failed-walk trace carries the verdict's reason as reach_reason", () => {
    expect(src).toMatch(/persistFailedWalkTrace\(_goalStr, walkStepSink, seek\.completionShapes, seek\.goalReachReason,/);
    expect(src).toMatch(/termination_reason: termination,\s*\n\s*reach_reason: reachReason \?\? null,/);
  });
  it("the floor's trace carries the verdict's reason as reach_reason", () => {
    expect(src).toMatch(/reach_reason: verdict\?\.reason \?\? null,/);
  });
});
