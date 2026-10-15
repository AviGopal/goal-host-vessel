// SERVER-SIDE EXECUTED TOOLS GROUND A FLOOR ANSWER (B3b).
//
// The floor's dispatch (llm_completion_dispatch -> an llmTextCompletion) may carry body.executed_tool_calls:
// [{iteration, tool_name, tool_input, tool_output | {error}, duration_ms}], the calls the llm-resolver EXECUTED itself
// before answering. The floor counted only the tool_calls it executed client-side, so an answer grounded on
// server-executed reads arrived as tools 0/0: the judge digest said "ZERO tools were executed", the credit class was
// floor:zero-tool, and the fabricated-transcript / zero-tool-write refusals could fire on a grounded answer.
//
// runGroundedToolLoop is DRIVEN with fetch spied (restored after): discovery answers one HTTP vessel for
// llm_completion_dispatch and nothing for walkBudget (the logged literal budget is used), and the dispatch answers
// the fixture. The loop's counts then feed the same digest and credit-class functions universalToolFallback uses.
// Import is dynamic for the reason given in index-pure-exports.test.ts.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { creditClassesOf } from "../src/judge/credit-classes";
import { floorInput } from "../src/judge/inputs";

process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
const m = await import("../src/index");

const DISPATCH_VESSEL = { id: "dispatch-vessel", endpoint: "http://llm-dispatch.test.invalid", resolve_endpoint: "/v2/impulses/resolve", protocol: "http" };
const ZERO = "[GROUNDING: ZERO tools were executed";

let spy: ReturnType<typeof spyOn> | null = null;
afterEach(() => { spy?.mockRestore(); spy = null; });

/** Drive the loop against one dispatch response (repeated for every turn); returns the loop result and the dispatch count. */
async function driveLoop(dispatchResponse: unknown) {
  let dispatches = 0;
  spy = spyOn(globalThis, "fetch").mockImplementation((async (_input: unknown, init?: { body?: unknown }) => {
    let b: any = {};
    try { b = JSON.parse(String(init?.body ?? "{}")); } catch { /* not JSON */ }
    if (b?.pointer?.type === "vesselCapability") {
      const vessels = b.pointer.shape === "llm_completion_dispatch" ? [DISPATCH_VESSEL] : [];
      return Response.json({ content: { vessels } });
    }
    if (b?.impulse?.pointer?.type === "llm_completion_dispatch") { dispatches++; return Response.json(dispatchResponse); }
    return new Response("not served by this fixture", { status: 503 });
  }) as unknown as typeof fetch);
  const loop = await m.runGroundedToolLoop("GOAL: how many lines does repos/widget-vessel/src/a.ts have?", [{ name: "codeSearchResult" }, { name: "fs_read" }], []);
  return { loop: loop!, dispatches };
}

const classesOf = (loop: { executed: unknown[]; executedOk: number; groundedOk: number; finalText: string }) =>
  creditClassesOf(floorInput({ goal: "g", targets: [], writes: [], answerText: loop.finalText, verdictReason: null, toolsTotal: loop.executed.length, toolsOk: loop.executedOk, groundedReads: loop.groundedOk }));

const textCompletion = (text: string, executed?: unknown[]) => ({ success: true, shape: "llmTextCompletion", body: { text, model: "fixture-model", ...(executed ? { executed_tool_calls: executed } : {}) } });

describe("the floor counts the tools the dispatch executed server-side", () => {
  test("[MUST-FAIL] successful executed calls ground the answer: groundedOk > 0, no ZERO tools prefix, not floor:zero-tool", async () => {
    const { loop, dispatches } = await driveLoop(textCompletion("repos/widget-vessel/src/a.ts has 42 lines (line_count from codeSearchResult).", [
      { iteration: 0, tool_name: "codeSearchResult", tool_input: { path: "repos/widget-vessel/src/a.ts" }, tool_output: { line_count: 42, path: "repos/widget-vessel/src/a.ts" }, duration_ms: 12 },
      { iteration: 0, tool_name: "fs_read", tool_input: { path: "repos/widget-vessel/src/b.ts" }, tool_output: { error: "ENOENT: no such file" }, duration_ms: 3 },
    ]));
    expect(dispatches).toBe(1);
    expect(loop.groundedOk).toBe(1);
    expect(loop.executedOk).toBe(1);
    expect(loop.executed).toEqual([{ tool: "codeSearchResult", ok: true }, { tool: "fs_read", ok: false }]);
    expect(loop.observations.some((o) => o.includes("[executed server-side]") && o.includes("\"line_count\":42"))).toBe(true);
    expect(loop.observations.some((o) => o.includes("fs_read ERROR (executed server-side): ENOENT"))).toBe(true);
    expect(loop.finalText).toContain("42 lines");
    expect(m.floorGroundingDigest(loop.executed.length, loop.groundedOk, loop.finalText).startsWith(ZERO)).toBe(false);
    expect(classesOf(loop)).not.toContain("floor:zero-tool");
    expect(classesOf(loop)).toContain("floor:tooled");
  });

  test("executed calls that all errored are not grounding", async () => {
    const { loop } = await driveLoop(textCompletion("I could not read the file.", [
      { iteration: 0, tool_name: "codeSearchResult", tool_input: { path: "repos/widget-vessel/src/a.ts" }, tool_output: { error: "file not found" }, duration_ms: 4 },
      { iteration: 0, tool_name: "fs_read", tool_input: { path: "repos/widget-vessel/src/a.ts" }, error: "resolver unavailable", duration_ms: 2 },
      { iteration: 0, tool_name: "fs_grep", tool_input: { pattern: "x" }, duration_ms: 1 },
    ]));
    expect(loop.groundedOk).toBe(0);
    expect(loop.executedOk).toBe(0);
    // Counted as tools that ran and failed (so the floor's all-tools-failed rule sees them), never as grounding.
    expect(loop.executed).toEqual([{ tool: "codeSearchResult", ok: false }, { tool: "fs_read", ok: false }, { tool: "fs_grep", ok: false }]);
    expect(loop.observations).toEqual([
      "TOOL codeSearchResult ERROR (executed server-side): file not found",
      "TOOL fs_read ERROR (executed server-side): resolver unavailable",
      "TOOL fs_grep ERROR (executed server-side): no tool_output",
    ]);
  });

  test("no executed_tool_calls: today's behaviour exactly (0/0, ZERO tools prefix, floor:zero-tool)", async () => {
    const { loop, dispatches } = await driveLoop(textCompletion("It has 42 lines."));
    expect(dispatches).toBe(1);
    expect(loop).toEqual({ finalText: "It has 42 lines.", groundedOk: 0, executedOk: 0, executed: [], observations: [], calledWriteShapes: new Set<string>(), commandEvidence: "" });
    expect(m.floorGroundingDigest(0, 0, "base").startsWith(ZERO)).toBe(true);
    expect(m.floorGroundingDigest(0, 0, "base").endsWith("\n\nbase")).toBe(true);
    expect(classesOf(loop)).toContain("floor:zero-tool");
    expect(m.executedToolCallsOf({ body: { text: "x" } })).toEqual([]);
    expect(m.executedToolCallsOf({ body: { executed_tool_calls: "not an array" } })).toEqual([]);
  });
});
