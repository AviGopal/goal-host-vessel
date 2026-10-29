// THE FLOOR IS OFFERED A STORE-WRITE TARGET'S READ SIBLING, SO IT CAN MEASURE THE WRITE IT MAKES.
//
// The floor's read-back gate (reach-grounding.ts changeEvidence, groundingPreGate rule 7) confirms a claimed store write
// only by a LATER read of the same store in the floor's ordered tool list. floorTargetCandidates left every write shape
// out (they keep their own write-tool path) and offered no read in its place, so a floor whose target was a note write
// could write the note and never read it back: graded "unconfirmed" whatever it did. The floor is now offered the
// write's read sibling (applied-write.ts writeReadShape, the walk's own read-back shape) when this substrate serves it.
// The gate itself is unchanged: the write is confirmed only when the floor actually calls the read after it.
//
//   [MUST-FAIL] a store-write target brings its served read sibling into the floor's target offer.
//   [MUST-FAIL] driven through the floor's tool loop: a note write, then a read of the notes, is executed and passes
//               the read-back gate (reached by the judge, not "unwritten-change-claim").
//   [CONTROL]   a floor write that is not read back is still refused "unconfirmed", and the judge is not asked.
//   [CONTROL]   a non-write target is offered exactly as before; a write whose read sibling is not served adds nothing;
//               the sibling still obeys the shell / exclusion rules.
//
// Fixture goal from a fresh 5-word draw (draw-words.sh):
//   2026-10-29T22:47:26Z seed=1793314046084619471 words=drainable stucco surround strobe huntress
//
// runGroundedToolLoop is DRIVEN with fetch spied (restored after), as in floor-search-and-bounded-shell.test.ts: the
// resolvers are fixtures, nothing is written. Import is dynamic for the reason given in index-pure-exports.test.ts.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { judgeReach } from "../src/reach-grounding";

process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
const m = await import("../src/index") as any;
const ft = (await import("../src/floor-tools")) as Record<string, any>;
const { NAMED_SHAPE_EXCLUDE } = await import("../src/goal-target-inference");

const GOAL = "Keep a note that the stucco on the surround wall is drainable, so the huntress crew can skip the strobe test.";
const NOTE_ID = "stucco-surround-drainable";
const ANSWER = `I saved the note ${NOTE_ID} and read it back from the notes: the stucco on the surround wall is drainable.`;
const NOW = new Date("2026-10-29T22:50:00.000Z");
const DISPATCH_VESSEL = { id: "dispatch-vessel", endpoint: "http://llm-dispatch.test.invalid", resolve_endpoint: "/v2/impulses/resolve", protocol: "http" };
const DEV_VESSEL = { id: "development-vessel", endpoint: "http://dev.test.invalid", resolve_endpoint: "/v2/impulses/resolve", protocol: "http" };
const SERVED = new Set(["memoryNote", "memoryNote_write"]);
const KNOWN = new Set(["fs_read", "codeSearchResult", "fs_grep", "substrateGap", "web_search", "bounded_shell", "memoryNote", "memoryNote_write", "docs_align_tick"]);
const CODE = "deterministic:unwritten-change-claim — ";

const tool = (name: string) => ({ name, description: `the ${name} shape`, input_schema: { type: "object", properties: {} } });

/** The floor's offer, built as universalToolFallback builds it: the hand tools discovery advertises, a tool per
 *  floorTargetCandidates entry, then a tool per write target. */
function floorOffer(targets: string[]): { tools: any[]; writeShapes: string[] } {
  const hand = new Set(ft["floorHandToolNames"](KNOWN));
  const tools: any[] = (ft["UNIVERSAL_FLOOR_TOOLS"] as any[]).filter((t) => hand.has(t.name));
  for (const ts of ft["floorTargetCandidates"](targets, KNOWN, NAMED_SHAPE_EXCLUDE)) tools.push(tool(ts));
  const writeShapes = targets.filter((s) => /(_write|_create_write)$/.test(s));
  for (const ws of writeShapes) tools.push(tool(ws));
  return { tools, writeShapes };
}

let spy: ReturnType<typeof spyOn> | null = null;
afterEach(() => { spy?.mockRestore(); spy = null; });

/** Drive the loop: one model turn per entry of `turns` (each a list of tool calls), then `answer`. */
async function drive(targets: string[], turns: Array<Array<{ tool_name: string; tool_input: Record<string, unknown> }>>, answer: string) {
  let turn = 0;
  const offered: string[][] = [];
  const resolved: string[] = [];
  spy = spyOn(globalThis, "fetch").mockImplementation((async (_i: unknown, init?: { body?: unknown }) => {
    let b: any = {};
    try { b = JSON.parse(String(init?.body ?? "{}")); } catch { /* not JSON */ }
    if (b?.pointer?.type === "vesselCapability") {
      const s = b.pointer.shape;
      return Response.json({ content: { vessels: s === "llm_completion_dispatch" ? [DISPATCH_VESSEL] : SERVED.has(s) ? [DEV_VESSEL] : [] } });
    }
    const p = b?.impulse?.pointer;
    if (p?.type === "llm_completion_dispatch") {
      offered.push((p.tools ?? []).map((t: any) => String(t?.name)));
      const calls = turns[turn++];
      return Response.json(calls
        ? { success: true, shape: "llmTextCompletion", body: { text: "", tool_calls: calls } }
        : { success: true, shape: "llmTextCompletion", body: { text: answer } });
    }
    if (p?.type === "memoryNote_write") { resolved.push(p.type); return Response.json({ success: true, content: { id: NOTE_ID, action: "created" } }); }
    if (p?.type === "memoryNote") { resolved.push(p.type); return Response.json({ success: true, content: { notes: [{ id: NOTE_ID, title: NOTE_ID, body: "The stucco on the surround wall is drainable." }] } }); }
    return new Response("not served by this fixture", { status: 503 });
  }) as unknown as typeof fetch);
  const { tools, writeShapes } = floorOffer(targets);
  const loop = await m.runGroundedToolLoop(`GOAL: ${GOAL}`, tools, writeShapes);
  return { loop: loop!, offered, resolved };
}

/** The floor's judge input, built as universalToolFallback builds it from the loop. */
function floorInput(loop: any, targets: string[]) {
  const toolSummary = loop.executed.map((e: any) => `${e.tool}${e.ok ? "" : "!"}`).join(", ");
  return {
    goal: GOAL,
    producedShapes: m["floorJudgedShapes"](targets, loop.calledWriteShapes, loop.executed) as string[],
    taskSummary: `universal ReAct fallback: ${loop.groundedOk} grounded read result(s) + ${loop.calledWriteShapes.size} write(s), ${loop.executedOk}/${loop.executed.length} tool call(s) OK [${toolSummary}]`,
    contentDigest: loop.finalText,
    now: NOW,
  };
}

function rubberStamp() {
  const prompts: string[] = [];
  return { prompts, complete: async (p: string) => { prompts.push(p); return JSON.stringify({ reached: true, reason: "the note was saved and read back", completion_shapes: [] }); } };
}

const WRITE = { tool_name: "memoryNote_write", tool_input: { note: { id: NOTE_ID, title: NOTE_ID, body: "The stucco on the surround wall is drainable." } } };
const READ = { tool_name: "memoryNote", tool_input: { id: NOTE_ID } };

describe("a store-write target brings its read sibling to the floor", () => {
  test("[MUST-FAIL] the served read sibling of a store-write target is offered as a target tool", () => {
    expect(ft["floorTargetCandidates"](["memoryNote_write"], KNOWN, NAMED_SHAPE_EXCLUDE)).toEqual(["memoryNote"]);
    // alongside a non-write target, in target order, once
    expect(ft["floorTargetCandidates"](["docs_align_tick", "memoryNote_write", "memoryNote_write"], KNOWN, NAMED_SHAPE_EXCLUDE)).toEqual(["docs_align_tick", "memoryNote"]);
  });

  test("[MUST-FAIL] driven: a note write, then a read of the notes, passes the read-back gate", async () => {
    const targets = ["memoryNote_write"];
    const { loop, offered, resolved } = await drive(targets, [[WRITE], [READ]], ANSWER);
    expect(offered[0]).toContain("memoryNote");
    expect(resolved).toEqual(["memoryNote_write", "memoryNote"]);
    expect(loop.executed).toEqual([{ tool: "memoryNote_write", ok: true }, { tool: "memoryNote", ok: true }]);
    const j = rubberStamp();
    const v = await judgeReach(floorInput(loop, targets), j.complete);
    expect(v?.reason ?? "").not.toContain("unwritten-change-claim");
    expect(v?.reached).toBe(true);
    expect(j.prompts.length).toBe(1);
  }, 30_000);
});

describe("[CONTROL] the gate and the offer are otherwise unchanged", () => {
  test("a floor write that is not read back is still refused unconfirmed, and the judge is not asked", async () => {
    const targets = ["memoryNote_write"];
    const { loop, resolved } = await drive(targets, [[WRITE]], `I saved the note ${NOTE_ID}: the stucco on the surround wall is drainable.`);
    expect(resolved).toEqual(["memoryNote_write"]);
    const j = rubberStamp();
    const v = await judgeReach(floorInput(loop, targets), j.complete);
    expect(v?.reached).toBe(false);
    expect(v?.reason.startsWith(`${CODE}unconfirmed:`)).toBe(true);
    expect(j.prompts.length).toBe(0);
  }, 30_000);

  test("a non-write target is offered as before; an unserved read sibling adds nothing; the rules still hold", () => {
    expect(ft["floorTargetCandidates"](["docs_align_tick"], KNOWN, NAMED_SHAPE_EXCLUDE)).toEqual(["docs_align_tick"]);
    // memoryNote not served: the write target brings nothing
    const noRead = new Set([...KNOWN].filter((s) => s !== "memoryNote"));
    expect(ft["floorTargetCandidates"](["memoryNote_write"], noRead, NAMED_SHAPE_EXCLUDE)).toEqual([]);
    // an excluded sibling is not offered
    expect(ft["floorTargetCandidates"](["memoryNote_write"], KNOWN, new Set(["memoryNote"]))).toEqual([]);
    // a write whose derived read is a hand tool or a shell is not re-offered as a target
    expect(ft["floorTargetCandidates"](["shellResult_write"], new Set([...KNOWN, "shellResult", "shellResult_write"]), new Set())).toEqual([]);
  });
});
