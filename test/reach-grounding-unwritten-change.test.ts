import { describe, it, expect } from "bun:test";
import * as RG from "../src/reach-grounding";
import { judgeReach, type ReachJudgeInput } from "../src/reach-grounding";

// Namespace reads, so the file loads at the parent (where these exports do not exist) and its tests fail by name there.
const storeFamilyOf = (s: string): string | undefined => (RG as any).storeFamilyOf?.(s);
const claimsPerformedChange = (t: string): boolean | undefined => (RG as any).claimsPerformedChange?.(t);

// Gap: the reach judge credits an answer that CLAIMS a change nothing in the chain made. Probe c1bbfc9f ended reached
// on the floor: one human_surface:ui_view READ, no write, and an answer asserting a completed change; the view was
// unchanged. groundingPreGate rule 7
// (unwritten-change-claim) refuses a change claim unless a store write succeeded and a later step read that store back.
// The model stub is the measured failure: a judge that grades any coherent answer reached.
//
// No fixture reuses the probe's goal or answer wording (no-leak: research's preregistered surface goals stay unseen);
// every fixture goal comes from a 5-word draw (draw-words.sh, 2026-10-26T17:18:03Z and 17:41:55Z):
//   D5 seed=1793036515858243627 evacuate sampling protector reclusive wired -> the probe's SHAPE (MF)
//   D1 seed=1793035083758850191 fritter entertain velvet anywhere hatbox   -> write + confirming read-back (control 1)
//   D2 seed=1793035083772562607 angling shorten moonshine yard rockfish    -> read report, no change claim (control 2)
//   D3 seed=1793035083782942958 automated dock underage unlit arrange      -> write with no read-back
//   D4 seed=1793035083794537756 capillary struggle tighten uncheck number  -> errored / empty write

const NOW = new Date("2026-10-26T17:30:00.000Z");
const PROBE_GOAL = "Wire the reclusive protector into the evacuate sampling schedule.";
const PROBE_ANSWER = "The evacuate sampling schedule was successfully modified, with the reclusive protector wired in as requested.";
const CODE = "deterministic:unwritten-change-claim — ";

function rubberStamp(reached = true) {
  const prompts: string[] = [];
  const complete = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return JSON.stringify({ reached, reason: "the answer addresses the goal", completion_shapes: [] });
  };
  return { complete, prompts };
}

const envelope = (text: string) =>
  JSON.stringify({ success: true, shape: "llmTextCompletion", body: { text, model: "some-model", requested_model: "auto" } });

const UI_VIEW = JSON.stringify({ resolved: true, success: true, shape: "human_surface:ui_view", body: { goal_dispatch: { open: true }, component_counts: { cards: 3, chips: 7, feed_lines: 50 } } });

/** The probe as the floor hands it to the judge (index.ts universalToolFallback): producedShapes = the requested targets
 *  plus the executed read (floorJudgedShapes), the ordered tool list in taskSummary, and the authored answer as one
 *  unlabelled digest. */
function probeOnTheFloor(answer = PROBE_ANSWER): ReachJudgeInput {
  return {
    goal: PROBE_GOAL,
    producedShapes: ["uiFeedback", "human_surface:ui_view"],
    taskSummary: "universal ReAct fallback: 1 grounded read result(s) + 0 write(s), 1/1 tool call(s) OK [human_surface:ui_view]",
    contentDigest: answer,
    now: NOW,
  };
}

/** A walk: steps in production order, each with its digest segment, then the answering llm step. */
function walk(goal: string, steps: Array<[string, string]>, answer: string): ReachJudgeInput {
  return {
    goal,
    producedShapes: ["goal", "dispatch_id", ...steps.map(([s]) => s), "llm_completion_dispatch"],
    taskSummary: `${steps.length + 1} steps: ${[...steps.map(([s]) => s), "llm_completion_dispatch"].join(" -> ")}`,
    contentDigest: [...steps.map(([s, c]) => `- ${s}: ${c}`), `- llm_completion_dispatch: ${envelope(answer)}`].join("\n"),
    now: NOW,
  };
}

describe("rule 7: a claimed change needs a write and a read-back", () => {
  it("MF: the probe on the floor (a ui_view read, no write, an answer asserting a completed change) is not reached with the code, and the judge is not asked", async () => {
    const j = rubberStamp();
    const v = await judgeReach(probeOnTheFloor(), j.complete);
    expect(v?.reached).toBe(false);
    expect(v?.deterministic).toBe(true);
    expect(v?.reason.startsWith(`${CODE}unwritten:`)).toBe(true);
    expect(j.prompts.length).toBe(0);
  });

  it("MF: the same shape on a walk (a ui_view read segment plus an llm answer claiming the update) is not reached", async () => {
    const j = rubberStamp();
    const v = await judgeReach(walk(PROBE_GOAL, [["human_surface:ui_view", UI_VIEW]], PROBE_ANSWER), j.complete);
    expect(v?.reached).toBe(false);
    expect(v?.reason.startsWith(`${CODE}unwritten:`)).toBe(true);
    expect(j.prompts.length).toBe(0);
  });

  it("D3: a store write with no later read-back of that store is refused as unconfirmed", async () => {
    const goal = "Arrange the unlit dock panels so the automated underage warning is pinned first.";
    const wrote = JSON.stringify({ resolved: true, shape: "uiPanel_write", body: { id: "panel-dock-7", title: "Underage warning", kind: "info" } });
    const j = rubberStamp();
    const v = await judgeReach(walk(goal, [["uiPanel_write", wrote]], "I have pinned the automated underage warning at the top of the unlit dock."), j.complete);
    expect(v?.reached).toBe(false);
    expect(v?.reason.startsWith(`${CODE}unconfirmed:`)).toBe(true);
    expect(j.prompts.length).toBe(0);
    // A read of a DIFFERENT store after the write is not a read-back of it: uiPanel is not ui_view.
    const other = await judgeReach(walk(goal, [["uiPanel_write", wrote], ["human_surface:ui_view", UI_VIEW]], "I have pinned the automated underage warning at the top of the unlit dock."), rubberStamp().complete);
    expect(other?.reached).toBe(false);
    expect(other?.reason.startsWith(`${CODE}unconfirmed:`)).toBe(true);
    // A read of the same store that ran BEFORE the write confirms nothing.
    const before = await judgeReach(walk(goal, [["uiPanel", JSON.stringify({ panels: [{ id: "panel-dock-7" }] })], ["uiPanel_write", wrote]], "I have pinned the automated underage warning first."), rubberStamp().complete);
    expect(before?.reached).toBe(false);
  });

  it("D4: an errored or empty write does not count as a write", async () => {
    const goal = "Uncheck the capillary number item and tighten the struggle list on my board.";
    for (const out of [JSON.stringify({ success: false, error: "panel not found" }), "{}", "[]"]) {
      const j = rubberStamp();
      const v = await judgeReach(walk(goal, [["uiPanel_write", out], ["uiPanel", JSON.stringify({ panels: [{ id: "panel-board-1", title: "capillary number" }] })]], "I have unchecked the capillary number item and tightened the struggle list."), j.complete);
      expect(v?.reached).toBe(false);
      expect(v?.reason.startsWith(`${CODE}unwritten:`)).toBe(true);
      expect(j.prompts.length).toBe(0);
    }
    // On the floor a failed write call is marked "!" in the tool list.
    const floor = await judgeReach({
      goal, producedShapes: ["uiPanel_write", "uiPanel"],
      taskSummary: "universal ReAct fallback: 1 grounded read result(s) + 0 write(s), 1/2 tool call(s) OK [uiPanel_write!, uiPanel]",
      contentDigest: "I have successfully changed the board.", now: NOW,
    }, rubberStamp().complete);
    expect(floor?.reached).toBe(false);
    expect(floor?.reason.startsWith(`${CODE}unwritten:`)).toBe(true);
  });
});

describe("controls: what rule 7 leaves alone", () => {
  it("D1 (control 1): a store write plus a later read-back holding the written record is reached (the judge decides)", async () => {
    const goal = "Save a note called velvet-hatbox saying the fritter recipe will entertain guests anywhere.";
    const wrote = JSON.stringify({ success: true, shape: "memoryNote_write", body: { id: "velvet-hatbox", title: "velvet-hatbox" } });
    const read = JSON.stringify({ success: true, body: { notes: [{ id: "velvet-hatbox", content: "The fritter recipe will entertain guests anywhere." }] } });
    const j = rubberStamp();
    const v = await judgeReach(walk(goal, [["memoryNote_write", wrote], ["memoryNote", read]], "I have saved the note velvet-hatbox, and it reads back with the fritter line."), j.complete);
    expect(v?.reached).toBe(true);
    expect(j.prompts.length).toBe(1);
    // The same on the floor: the write, then a read of the same store, in the ordered tool list.
    const floor = await judgeReach({
      goal, producedShapes: ["memoryNote_write", "memoryNote"],
      taskSummary: "universal ReAct fallback: 1 grounded read result(s) + 1 write(s), 2/2 tool call(s) OK [memoryNote_write, memoryNote]",
      contentDigest: "I have successfully saved the note velvet-hatbox.", now: NOW,
    }, rubberStamp().complete);
    expect(floor?.reached).toBe(true);
  });

  it("D1: a read-back of the same store that does not hold the written record confirms nothing", async () => {
    const goal = "Save a note called velvet-hatbox saying the fritter recipe will entertain guests anywhere.";
    const wrote = JSON.stringify({ success: true, shape: "memoryNote_write", body: { id: "velvet-hatbox", title: "velvet-hatbox" } });
    const v = await judgeReach(walk(goal, [["memoryNote_write", wrote], ["memoryNote", JSON.stringify({ body: { notes: [{ id: "some-other-note" }] } })]], "I have saved the note velvet-hatbox."), rubberStamp().complete);
    expect(v?.reached).toBe(false);
    expect(v?.reason.startsWith(`${CODE}unconfirmed:`)).toBe(true);
  });

  it("D2 (control 2): a read report that describes past changes, with no claim the run made one, is unaffected", async () => {
    const goal = "What changed in the rockfish angling thread since the yard sale, and did anyone shorten the moonshine section?";
    const answer = "The rockfish angling thread was updated yesterday: Dana shortened the moonshine section and added three yard-sale photos.";
    const j = rubberStamp();
    const v = await judgeReach(walk(goal, [["human_surface:ui_view", UI_VIEW]], answer), j.complete);
    expect(v?.reached).toBe(true);
    expect(j.prompts.length).toBe(1);
  });

  it("an answer that says it could NOT make the change is not a claim (the judge decides)", async () => {
    const j = rubberStamp(false);
    const v = await judgeReach(probeOnTheFloor("Nothing was moved as requested: no tool here writes the sampling schedule."), j.complete);
    expect(v?.reason.startsWith(CODE)).toBe(false);
    expect(j.prompts.length).toBe(1);
  });

  it("the change-claim cues: a claim of the run's own change, never a report of someone else's", () => {
    expect(claimsPerformedChange(PROBE_ANSWER)).toBe(true);
    expect(claimsPerformedChange("I have pinned the automated underage warning first.")).toBe(true);
    expect(claimsPerformedChange("The rockfish angling thread was updated yesterday: Dana shortened the moonshine section and added three yard-sale photos.")).toBe(false);
    expect(claimsPerformedChange("Nothing was moved as requested: no tool here writes the sampling schedule.")).toBe(false);
    expect(claimsPerformedChange("I checked the sampling schedule; it lists the protector already.")).toBe(false);
  });

  it("the store family follows the walk's own read-back derivation", () => {
    expect(storeFamilyOf("uiView_write")).toBe("uiview");
    expect(storeFamilyOf("human_surface:ui_view")).toBe("uiview");
    expect(storeFamilyOf("uiPanel_write")).not.toBe(storeFamilyOf("human_surface:ui_view"));
    expect(storeFamilyOf("concept_create_write")).toBe(storeFamilyOf("concept"));
    expect(storeFamilyOf("memoryNote_write")).toBe(storeFamilyOf("memoryNote"));
  });
});
