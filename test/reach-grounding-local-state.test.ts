import { describe, it, expect } from "bun:test";
import { judgeReach, type ReachJudgeInput } from "../src/reach-grounding";

// Check-first test for the third referent class of gap
// the-llm-reach-judge-accepts-ungrounded-answers-to-current-information-and-self-description-goals:
// a question about THIS system's own state (its filesystem, config, processes, units, stores) answered
// from model memory. A held-out probe asked for the structure of the full filesystem from root, the walk
// answered with ONE llm_completion_dispatch step and read nothing, and the judge granted reach to a
// generic Linux tree. The model stub below is that judge: it grades any coherent answer reached.
//
// The local-state rule decides before the judge; the judge is still asked IN SHADOW and its verdict is
// recorded as judge_verdict_before_pregate, never used. The trigger is STRUCTURAL, not a word list: the
// goal's targets that this substrate's own vessels serve (localTargets, resolved by index.ts through
// discovery). These unit tests hand that in; test/local-state-gate.test.ts covers the resolution.

const NOW = new Date("2026-10-18T12:00:00.000Z");

function rubberStamp(reached = true) {
  const prompts: string[] = [];
  const complete = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return JSON.stringify({ reached, reason: "the answer addresses the goal", completion_shapes: ["llm_completion_dispatch"] });
  };
  return { complete, prompts };
}

const envelope = (text: string) =>
  JSON.stringify({ success: true, shape: "llmTextCompletion", body: { text, model: "some-model", requested_model: "auto" } });

const FS_GOAL = "What is the structure of the full filesystem from root? List the top-level directories and what each one holds.";
const GENERIC_TREE = "The root contains /bin for essential binaries, /etc for configuration, /home for user directories, /usr for user programs and /var for variable data such as logs.";

function chain(goal: string, answer: string, extra: { shape: string; line: string }[] = [], localTargets: string[] = ["shellResult"]): ReachJudgeInput {
  return {
    goal,
    localTargets,
    producedShapes: ["goal", "dispatch_id", ...extra.map((e) => e.shape), "llm_completion_dispatch"],
    taskSummary: `${extra.length + 1} step(s)`,
    contentDigest: [...extra.map((e) => `- ${e.shape}: ${e.line}`), `- llm_completion_dispatch: ${envelope(answer)}`].join("\n"),
    now: NOW,
  };
}

describe("reach grounding: a question about this system's own state needs a local read", () => {
  it("must-fail: the filesystem-from-root goal answered by ONE llm step → not reached, unsourced-local-state; the judge's reach is recorded, not used", async () => {
    const j = rubberStamp();
    const v = await judgeReach(chain(FS_GOAL, GENERIC_TREE), j.complete);
    expect(v?.reached).toBe(false);
    expect(v?.deterministic).toBe(true);
    expect(v?.reason).toMatch(/^deterministic:unsourced-local-state /);
    // SHADOW: the judge was asked and said reached; that is recorded beside the gate's verdict.
    expect(j.prompts.length).toBe(1);
    expect(v?.judge_verdict_before_pregate).toEqual({ reached: true, reason: "the answer addresses the goal" });
  });

  it("a shadow call is made through the shadow model call when one is given, never the judge's own", async () => {
    const j = rubberStamp();
    const sh = rubberStamp(false);
    const v = await judgeReach(chain(FS_GOAL, GENERIC_TREE), j.complete, sh.complete);
    expect(j.prompts.length).toBe(0);
    expect(sh.prompts.length).toBe(1);
    expect(v?.judge_verdict_before_pregate?.reached).toBe(false);
  });

  it("must-fail: a units-running question on this host answered from memory → not reached", async () => {
    const j = rubberStamp();
    const v = await judgeReach(chain("Which systemd units are running on this host?", "Typically sshd, cron and systemd-journald are running."), j.complete);
    expect(v?.reached).toBe(false);
  });

  it("control: the same goal with a shellResult read in the chain → the judge decides, unchanged, no shadow record", async () => {
    const j = rubberStamp();
    const v = await judgeReach(chain(FS_GOAL, GENERIC_TREE, [{ shape: "shellResult", line: '{"stdout":"bin\\netc\\nhome\\nusr\\nvar\\nworkspace","exit_code":0}' }]), j.complete);
    expect(j.prompts.length).toBe(1);
    expect(v?.reached).toBe(true);
    expect(v?.deterministic).toBe(false);
    expect(v?.judge_verdict_before_pregate).toBeUndefined();
  });

  it("control: the same goal with a fileContent read → the judge decides", async () => {
    const j = rubberStamp(false);
    const v = await judgeReach(chain(FS_GOAL, GENERIC_TREE, [{ shape: "fileContent", line: '{"path":"/","content":"bin etc home"}' }]), j.complete);
    expect(j.prompts.length).toBe(1);
    expect(v?.reached).toBe(false);
    expect(v?.reason).toBe("the answer addresses the goal");
  });

  it("control: a web search is not a local read → still not reached", async () => {
    const j = rubberStamp();
    const v = await judgeReach(chain(FS_GOAL, GENERIC_TREE, [{ shape: "web_search", line: '{"results":[{"title":"Filesystem Hierarchy Standard","url":"https://example.org/fhs"}]}' }]), j.complete);
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^deterministic:unsourced-local-state /);
  });

  it("control: the same filesystem goal with NO local target → the judge decides: words alone never trigger it", async () => {
    const j = rubberStamp();
    const v = await judgeReach(chain(FS_GOAL, GENERIC_TREE, [], []), j.complete);
    expect(j.prompts.length).toBe(1);
    expect(v?.reached).toBe(true);
    expect(v?.judge_verdict_before_pregate).toBeUndefined();
  });

  it("control: a world-fact goal that says 'running' is unaffected → the judge decides, no shadow record", async () => {
    const j = rubberStamp();
    const v = await judgeReach(chain("Who is running for mayor of the largest city in Portugal, and what are their platforms?", "Several candidates are running; the main ones focus on housing and transport.", [], []), j.complete);
    expect(j.prompts.length).toBe(1);
    expect(v?.reached).toBe(true);
    expect(v?.judge_verdict_before_pregate).toBeUndefined();
  });

  it("control: a self-description goal still hits its own rule, and the judge is not asked", async () => {
    const j = rubberStamp();
    const v = await judgeReach(chain("What are you, and what is this system for?", "I am a large language model trained to be helpful.", [], []), j.complete);
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^deterministic:ungrounded-self-description /);
    expect(j.prompts.length).toBe(0);
    expect(v?.judge_verdict_before_pregate).toBeUndefined();
  });
});
