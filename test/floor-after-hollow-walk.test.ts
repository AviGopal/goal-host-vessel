// THE FLOOR AFTER A HOLLOW WALK IS THE REACT LOOP: IT IS NEITHER OFFERED NOR JUDGED ON THE WALK'S FAILED TARGETS.
//
// CLAUDE.md floor-parity contract: "the walk with tool-enabled fallback IS the ReAct loop". On node1 (10-28) a general
// question's walk ended hollow on inferred targets no producer could satisfy (repairPolicy, maintenanceLease). The floor
// then ran web_search 3/3 OK and wrote a 3137-char answer, but it was offered those two shapes as target tools and the
// reach judge was told they were the produced shapes, so the answer was graded against them ("floor:upstream-not-reached").
// After a hollow walk the floor now keeps only the goal's WRITE targets (floorTargetsAfterWalk); its answer is judged as
// an answer: what its tools ran plus its text.
//
//   [MUST-FAIL] after a hollow walk on wrong targets, the floor offers no target tool for them and the judge is shown only
//               what the floor's tools ran (no repairPolicy / maintenanceLease); the post-walk call site says the walk
//               ended hollow and the floor uses the trimmed targets everywhere it offers or judges.
//   [CONTROL]   a walk that did not end hollow keeps its targets; a write target survives a hollow walk.
//   [CONTROL]   a floor that ran no tools and produced no text is still not reached.
//
// Fixture goal from a fresh 5-word draw (draw-words.sh):
//   2026-10-28T19:30:28Z seed=1793215828966868210 words=duplicate energy litigator bronchial jawless
import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fwc from "../src/floor-walk-context";
import { floorTargetCandidates } from "../src/floor-tools";
import { buildReachJudgePrompt } from "../src/reach-grounding";

process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
const m = (await import("../src/index")) as Record<string, any>;
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
const after = (fwc as Record<string, unknown>)["floorTargetsAfterWalk"] as ((t: readonly string[], hollow: boolean) => string[]) | undefined;

const GOAL = "My cousin, a litigator with a lingering bronchial cough, keeps running low on energy by mid-afternoon. Suggest a simple daily routine that avoids duplicate effort, and mention why jawless fish keep coming up in her nature podcast.";
const WALK_TARGETS = ["repairPolicy", "maintenanceLease"];
const KNOWN = new Set(["fs_read", "codeSearchResult", "fs_grep", "substrateGap", "web_search", "bounded_shell", "repairPolicy", "maintenanceLease", "memoryNote_write"]);
const RAN = [{ tool: "web_search", ok: true }, { tool: "web_search", ok: true }];

describe("the floor after a hollow walk drops the walk's failed targets", () => {
  it("[MUST-FAIL] neither offered as target tools nor judged as produced shapes", () => {
    expect(typeof after).toBe("function");
    const targets = after!(WALK_TARGETS, true);
    expect(targets).toEqual([]);
    expect(floorTargetCandidates(targets, KNOWN, new Set())).toEqual([]);
    const produced = m["floorJudgedShapes"](targets, new Set(), RAN) as string[];
    expect(produced).toEqual(["web_search"]);
    const prompt = buildReachJudgePrompt(GOAL, produced, "universal ReAct fallback: 2 grounded read result(s) + 0 write(s), 2/2 tool call(s) OK [web_search, web_search]", "A routine: ...");
    expect(prompt).toContain('Produced output impulse shapes: ["web_search"]');
    expect(prompt).not.toContain("repairPolicy");
    expect(prompt).not.toContain("maintenanceLease");
  });

  it("[MUST-FAIL] wiring: the post-walk site says the walk ended hollow; the floor offers and judges the trimmed targets", () => {
    expect(INDEX).toContain("_ufOut, { carry: walk.carry, reason: walk.goalReachReason ?? null, walkEndedHollow: walk.reached === false, priorFeedback:");
    expect(INDEX).toContain("const judgedTargets = floorTargetsAfterWalk(targetShapes, walkContext?.walkEndedHollow === true);");
    expect(INDEX).toContain("for (const ts of floorTargetCandidates(judgedTargets, knownForFloor, NAMED_SHAPE_EXCLUDE)) {");
    expect(INDEX).toContain("const produced = floorJudgedShapes(judgedTargets, calledWriteShapes, executed);");
    expect(INDEX).toContain('{ persistedWrites: floorWrites, targets: judgedTargets, surface: "floor" }, "floor");');
    expect(INDEX).toContain("judgeInputs.floorInput({ goal, targets: judgedTargets, writes: floorWrites,");
  });

  it("[CONTROL] a walk that did not end hollow keeps its targets; a write target survives a hollow walk", () => {
    expect(after!(WALK_TARGETS, false)).toEqual(WALK_TARGETS);
    expect(after!(["repairPolicy", "memoryNote_write"], true)).toEqual(["memoryNote_write"]);
    expect(floorTargetCandidates(after!(WALK_TARGETS, false), KNOWN, new Set())).toEqual(WALK_TARGETS);
  });

  it("[CONTROL] driven through the floor's entry point: no tool run and no text, after a hollow walk, is NOT reached", async () => {
    // universalToolFallback with fetch spied: discovery serves only the dispatch; the dispatch answers no tool call and
    // empty text. The floor returns null (not reached) whatever targets the hollow walk handed it.
    const DISPATCH = { id: "dispatch-vessel", endpoint: "http://llm-dispatch.test.invalid", resolve_endpoint: "/v2/impulses/resolve", protocol: "http" };
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (_i: unknown, init?: { body?: unknown }) => {
      let b: any = {};
      try { b = JSON.parse(String(init?.body ?? "{}")); } catch { /* not JSON */ }
      if (b?.pointer?.type === "vesselCapability") return Response.json({ content: { vessels: b.pointer.shape === "llm_completion_dispatch" ? [DISPATCH] : [] } });
      if (b?.impulse?.pointer?.type === "llm_completion_dispatch") return Response.json({ success: true, shape: "llmTextCompletion", body: { text: "" } });
      return new Response("not served by this fixture", { status: 503 });
    }) as unknown as typeof fetch);
    try {
      const r = await m["universalToolFallback"](GOAL, WALK_TARGETS, undefined, {}, { walkEndedHollow: true });
      expect(r).toBeNull();
      expect(r?.reached === true).toBe(false);
    } finally { spy.mockRestore(); }
  }, 30_000);

  it("[CONTROL] a floor that ran no tools and produced no text is still not reached", () => {
    // the floor's own empty-loop exit returns no result (null: not reached) before any judging, whatever the targets
    expect(INDEX).toContain("if (groundedOk === 0 && !finalText.trim() && observations.length === 0) { console.log(`[goal-host-vessel] floor: exit=empty_loop goalHash=${goalHashOf(goal)}`); return null; }");
    expect(INDEX.indexOf("floor: exit=empty_loop")).toBeLessThan(INDEX.indexOf("const produced = floorJudgedShapes(judgedTargets, calledWriteShapes, executed);"));
    // and with nothing run, the judged shape is the floor's placeholder, never a dropped target
    expect(m["floorJudgedShapes"](after!(WALK_TARGETS, true), new Set(), [])).toEqual(["universal_fallback_result"]);
  });
});
