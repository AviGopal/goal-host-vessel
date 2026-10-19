import { describe, it, expect } from "bun:test";
import * as grounding from "../src/reach-grounding";
import { judgeReach, parseReachJudgeText, type ReachJudgeInput } from "../src/reach-grounding";

// Read through the namespace so this file loads on a tree without the helper and each case reports on its own.
const consultedInRun = (...a: [string[], string?, string?]): boolean => (grounding as unknown as { consultedInRun: (...x: [string[], string?, string?]) => boolean }).consultedInRun(...a);

// Reach condition 3, GROUNDED: a question about this system's own state with no read in its chain is not reached.
//
// The local-state rule (rule 5) is structural on the goal's TARGETS: it applies when a target is a read this substrate's
// own vessels serve. The explanatory prose route sends "what is …" questions to llm_completion_dispatch, an answer
// shape, so localTargets is empty and the rule never looks (named debt in 4b13567). RUN 4 graded six such dispatches
// reached: "What is the structure of the filesystem from root? …", inferred target llm_completion_dispatch, one
// satisfier step, no tool run, and a generic Unix-like tree from model memory that the judge accepted.
//
// The chain cannot tell that goal from a general-knowledge one (the orbital-path question below has the same chain), so
// the judge's own reply now also names the goal's SUBJECT. Code decides the rest: subject this_system and nothing
// consulted in-run (no source shape, no registry command, no tool the answering model ran itself) → not reached, with
// the judge's verdict recorded beside it. The subject can only ever refuse.

const NOW = new Date("2026-10-19T01:28:00.000Z");
const REASON = "The output accurately describes the structure of a Unix-like filesystem from root.";

function judge(reply: Record<string, unknown>) {
  const prompts: string[] = [];
  const complete = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return JSON.stringify({ reason: REASON, completion_shapes: ["llm_completion_dispatch"], ...reply });
  };
  return { complete, prompts };
}

/** The dispatch wrapper's envelope as the judge view renders a targeted llm_completion_dispatch: the whole JSON. */
const envelope = (text: string, executed?: unknown[]) =>
  JSON.stringify({ success: true, shape: "llmTextCompletion", body: { text, model: "some-model", requested_model: "auto", usage: { input_tokens: 700, output_tokens: 900 }, ...(executed ? { executed_tool_calls: executed } : {}) } });

const UNIX_TREE = "The structure of a Unix-like filesystem from the root typically follows a hierarchical directory structure. Below is an overview of the typical directories found in such a filesystem and the reasoning behind their ordering:\n\n1. **/** (Root)\n   - The top-level directory of the filesystem.\n\n2. **/bin**\n   - Contains essential binary executables (commands) that are needed for the system to operate in single-user mode and for all users to perform basic tasks (e.g., `ls`, `cp`, `mv`).\n\n3. **/boot**\n   - Holds the boot loader and files needed to start the system.";

/** The RUN 4 chain: goal, dispatch id, one llm_completion_dispatch satisfier step; the target was the answer shape. */
function oneLlmStep(goal: string, content: string, extraShapes: string[] = []): ReachJudgeInput {
  return {
    goal,
    localTargets: [],
    producedShapes: ["goal", "dispatch_id", ...extraShapes, "llm_completion_dispatch"],
    taskSummary: "walk(1 steps): satisfier:llm_completion_dispatch",
    contentDigest: `- llm_completion_dispatch: ${content}`,
    now: NOW,
  };
}

const FS_GOALS = [
  "What is the structure of the filesystem from root? Describe the reason behind the ordering?",
  "Can you explain the structure of the filesystem starting from root and clarify the reasoning for the ordering?",
  "What is the structure of the filesystem from root? How does it nest? Describe the reason behind the ordering?",
];

describe("reach grounding: a self-question answered from model memory is not reached, whatever its target", () => {
  for (const goal of FS_GOALS) {
    it(`must-fail: "${goal.slice(0, 60)}…" answered by one llm step with no tool run → unsourced-local-state; the judge's reach is recorded, not used`, async () => {
      const j = judge({ reached: true, subject: "this_system" });
      const v = await judgeReach(oneLlmStep(goal, envelope(UNIX_TREE)), j.complete);
      expect(v?.reached).toBe(false);
      expect(v?.deterministic).toBe(true);
      expect(v?.reason).toMatch(/^deterministic:unsourced-local-state /);
      expect(v?.judge_verdict_before_pregate).toEqual({ reached: true, reason: REASON });
      expect(j.prompts.length).toBe(1);
    });
  }

  it("must-fail: the judge is asked for the goal's subject", async () => {
    const j = judge({ reached: true, subject: "this_system" });
    await judgeReach(oneLlmStep(FS_GOALS[0]!, envelope(UNIX_TREE)), j.complete);
    expect(j.prompts[0]).toContain('"subject": "this_system" | "other"');
  });

  it("must-fail: the parser keeps a subject only when it is one of the two values", () => {
    const base = { reached: true, reason: "ok", completion_shapes: [] };
    expect(parseReachJudgeText(JSON.stringify({ ...base, subject: "this_system" }))?.subject).toBe("this_system");
    expect(parseReachJudgeText(JSON.stringify({ ...base, subject: "other" }))?.subject).toBe("other");
    expect(parseReachJudgeText(JSON.stringify({ ...base, subject: "THIS SYSTEM!" }))?.subject).toBeNull();
    expect(parseReachJudgeText(JSON.stringify(base))?.subject).toBeNull();
  });

  it("control: a general-knowledge question with the same chain (the orbital-path goal) is the judge's call", async () => {
    const j = judge({ reached: true, subject: "other" });
    const v = await judgeReach(oneLlmStep("What is the orbital path from LEO to the moon Io? Distance along the path? The optimal transit delta v?", envelope("A Hohmann transfer to Jupiter, then capture into an orbit near Io.")), j.complete);
    expect(v?.reached).toBe(true);
    expect(v?.deterministic).toBe(false);
    expect(v?.judge_verdict_before_pregate).toBeUndefined();
  });

  it("control: a self-question whose answering model ran a tool itself (the public-address goal, curl inside the wrapper) is the judge's call", async () => {
    const j = judge({ reached: true, subject: "this_system" });
    const ran = [{ iteration: 1, tool_name: "shellResult", tool_input: { command: "curl ifconfig.me" }, tool_output: { shape: "shellResult", stdout: "<address>" } }];
    const v = await judgeReach(oneLlmStep("What is your public ip?", envelope("My public IP address is <address>.", ran)), j.complete);
    expect(v?.reached).toBe(true);
    expect(v?.deterministic).toBe(false);
  });

  it("control: a self-question whose chain read the referent (fs_grep, then the answer) is the judge's call", async () => {
    const j = judge({ reached: true, subject: "this_system" });
    const v = await judgeReach(oneLlmStep("What code do you manage?", envelope("The fs_grep output shows the vessels under repos/ ..."), ["fs_grep"]), j.complete);
    expect(v?.reached).toBe(true);
    expect(v?.deterministic).toBe(false);
  });

  it("control: no subject, or a judge that says not reached, leaves the judge's verdict as it is", async () => {
    const none = await judgeReach(oneLlmStep(FS_GOALS[0]!, envelope(UNIX_TREE)), judge({ reached: true }).complete);
    expect(none?.reached).toBe(true);
    expect(none?.deterministic).toBe(false);
    const no = await judgeReach(oneLlmStep(FS_GOALS[0]!, envelope(UNIX_TREE)), judge({ reached: false, subject: "this_system" }).complete);
    expect(no?.reached).toBe(false);
    expect(no?.deterministic).toBe(false);
    expect(no?.reason).toBe(REASON);
  });

  it("control: an answer the view does not show whole (no parseable envelope) counts as consulted: unknown never refuses", () => {
    const cut = envelope(UNIX_TREE).slice(0, 200);
    expect(consultedInRun(["goal", "dispatch_id", "llm_completion_dispatch"], undefined, `- llm_completion_dispatch: ${cut}`)).toBe(true);
    expect(consultedInRun(["goal", "dispatch_id", "llm_completion_dispatch"], undefined, `- llm_completion_dispatch: ${envelope(UNIX_TREE)}`)).toBe(false);
    expect(consultedInRun(["goal", "dispatch_id", "llm_completion_dispatch"], "- shellResult was produced by RUNNING: `curl -s http://discovery.test.invalid/registry/stats`", `- llm_completion_dispatch: ${envelope(UNIX_TREE)}`)).toBe(true);
  });

  // MUST-HOLD (qa condition i): general questions answered with no tool run stay the judge's call when the judge reads
  // them as "other". The same chain as the residual class, so only the subject separates them.
  const GENERAL: Array<[string, string]> = [
    ["What is the orbital path from LEO to the moon Io? Distance along the path? The optimal transit delta v?", "A Hohmann transfer to Jupiter, then capture into an orbit near Io."],
    ["What is the capital of France?", "The capital of France is Paris."],
    ["Explain TCP slow start", "TCP slow start grows the congestion window exponentially from a small initial value until loss or the slow-start threshold."],
  ];
  for (const [goal, answer] of GENERAL) {
    it(`must-hold: "${goal.slice(0, 40)}" with subject other and no tool run stays judge-graded`, async () => {
      const v = await judgeReach(oneLlmStep(goal, envelope(answer)), judge({ reached: true, subject: "other" }).complete);
      expect(v?.reached).toBe(true);
      expect(v?.deterministic).toBe(false);
      expect(v?.judge_verdict_before_pregate).toBeUndefined();
    });
    it(`RISK, documented: "${goal.slice(0, 40)}" with the judge WRONGLY reading subject this_system is refused (a false refusal the record counts)`, async () => {
      const v = await judgeReach(oneLlmStep(goal, envelope(answer)), judge({ reached: true, subject: "this_system" }).complete);
      expect(v?.reached).toBe(false);
      expect(v?.reason).toMatch(/^deterministic:unsourced-local-state /);
      expect(v?.subject).toBe("this_system");
      expect(v?.judge_verdict_before_pregate).toEqual({ reached: true, reason: REASON });
    });
  }

  it("must-fail: the verdict records the judge's subject on a reached verdict, on a refusal, and as null when the reply names none (qa condition ii)", async () => {
    const reached = await judgeReach(oneLlmStep("What is the capital of France?", envelope("Paris.")), judge({ reached: true, subject: "other" }).complete);
    expect(reached?.reached).toBe(true);
    expect(reached?.subject).toBe("other");
    const refused = await judgeReach(oneLlmStep(FS_GOALS[0]!, envelope(UNIX_TREE)), judge({ reached: true, subject: "this_system" }).complete);
    expect(refused?.reached).toBe(false);
    expect(refused?.subject).toBe("this_system");
    const hollow = await judgeReach(oneLlmStep(FS_GOALS[0]!, envelope(UNIX_TREE)), judge({ reached: false, subject: "this_system" }).complete);
    expect(hollow?.subject).toBe("this_system");
    const unnamed = await judgeReach(oneLlmStep(FS_GOALS[0]!, envelope(UNIX_TREE)), judge({ reached: true }).complete);
    expect(unnamed?.reached).toBe(true);
    expect(unnamed && "subject" in unnamed).toBe(true);
    expect(unnamed?.subject).toBeNull();
  });
});
