// THE FLOOR'S CONTROLLER DECISIONS ARE TRACE STEPS (user ruling 2026-10-17T10:22:59Z, "Full declared-tier fix", F1).
//
// The universal tool fallback (the floor) recorded only its tool calls as trace tasks, each stamped "deterministic"
// (correctly: they are deterministic resolvers). The model controller that chose them, the stochastic cell, was recorded
// nowhere, so every floor trace classified all_deterministic and activity-api's M4 tier-restricted skip
// (posterior-update.ts applyOutcomeToPosteriors: classifyTraceTiers(trace.tasks) -> skipVariantUpdate) never let the
// floor's posterior move. Chain credit is not the path (it flows to ancestor executions in composition_chain; the floor
// has none), so the controller's decisions become llm-tier TASK records beside the tool tasks, outcome = reach verdict.
// MUST-FAIL on the parent (d124f2f): floorTraceTasks does not exist, the loop reports no decisions, and the floor's
// trace is built from tool calls alone.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["IAS_TRACE_SPOOL_DIR"] = mkdtempSync(join(tmpdir(), "floor-steps-spool-"));
process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
const m = await import("../src/index") as any;
const { TranslatingTraceSink } = await import("@avigopal/ias-executor-ts/adapters");
const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

const DISPATCH_VESSEL = { id: "dispatch-vessel", endpoint: "http://llm-dispatch.test.invalid", resolve_endpoint: "/v2/impulses/resolve", protocol: "http" };
let spy: ReturnType<typeof spyOn> | null = null;
afterEach(() => { spy?.mockRestore(); spy = null; });

/** Drive the loop: turn 1 asks for a tool, turn 2 answers. Discovery serves only the dispatch. */
async function driveTwoTurns() {
  let turn = 0;
  spy = spyOn(globalThis, "fetch").mockImplementation((async (_i: unknown, init?: { body?: unknown }) => {
    let b: any = {};
    try { b = JSON.parse(String(init?.body ?? "{}")); } catch { /* not JSON */ }
    if (b?.pointer?.type === "vesselCapability") return Response.json({ content: { vessels: b.pointer.shape === "llm_completion_dispatch" ? [DISPATCH_VESSEL] : [] } });
    if (b?.impulse?.pointer?.type === "llm_completion_dispatch") {
      turn++;
      return Response.json(turn === 1
        ? { success: true, shape: "llmTextCompletion", body: { text: "", tool_calls: [{ tool_name: "fs_read", tool_input: { path: "repos/widget-vessel/src/a.ts" } }] } }
        : { success: true, shape: "llmTextCompletion", body: { text: "the answer from what was read" } });
    }
    return new Response("not served by this fixture", { status: 503 });
  }) as unknown as typeof fetch);
  return m.runGroundedToolLoop("GOAL: read repos/widget-vessel/src/a.ts", [{ name: "fs_read" }], []);
}

describe("the floor trace records its controller's decisions as llm-tier steps", () => {
  test("[MUST-FAIL] the loop reports one decision per model response (tools chosen, then the final answer)", async () => {
    const loop = await driveTwoTurns();
    expect(loop.decisions).toEqual([
      { iter: 0, kind: "tool_calls", tools: ["fs_read"] },
      { iter: 1, kind: "final", tools: [] },
    ]);
  });

  test("[MUST-FAIL] floorTraceTasks: tool tasks unchanged, then one llm controller step per decision with outcome = reach", () => {
    expect(typeof m.floorTraceTasks).toBe("function");
    const tasks = m.floorTraceTasks([{ tool: "fs_grep", ok: true }, { tool: "fs_read", ok: false }], [{ iter: 0, kind: "tool_calls", tools: ["fs_grep", "fs_read"] }, { iter: 1, kind: "final", tools: [] }], true);
    expect(tasks.slice(0, 2)).toEqual([
      { taskId: "floor-tool-0", description: "fs_grep", resolverId: "fs_grep", resolverTier: "deterministic", inputImpulseIds: [], outputImpulseIds: [], outputShapes: [], success: true },
      { taskId: "floor-tool-1", description: "fs_read (failed)", resolverId: "fs_read", resolverTier: "deterministic", inputImpulseIds: [], outputImpulseIds: [], outputShapes: [], success: false },
    ]);
    expect(tasks.slice(2).map((t: any) => [t.taskId, t.resolverId, t.resolverTier, t.success])).toEqual([
      ["floor-decision-0", "llm_completion_dispatch", "llm", true],
      ["floor-decision-1", "llm_completion_dispatch", "llm", true],
    ]);
    expect(m.floorTraceTasks([], [{ iter: 0, kind: "final", tools: [] }], false)[0].success).toBe(false);
  });

  test("[MUST-FAIL] through the real TranslatingTraceSink the stored trace is no longer all-deterministic", async () => {
    const bodies: any[] = [];
    const sink = new TranslatingTraceSink("http://127.0.0.1:9", "test-key", {
      fetch: { request: async (url: string, init?: RequestInit) => { if (String(url).endsWith("/v2/activities/execution-traces")) bodies.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); } },
    } as never);
    const tasks = m.floorTraceTasks([{ tool: "fs_grep", ok: true }], [{ iter: 0, kind: "tool_calls", tools: ["fs_grep"] }, { iter: 1, kind: "final", tools: [] }], true);
    await sink.record({ id: "universal-tool-fallback-test-1", templateId: "universal-tool-fallback", status: "completed", compositionChain: [], inputImpulseIds: [], outputImpulseIds: [], tasks, costUsd: 0, durationMs: 0, tags: ["dispatcher_used:goal-host"] } as never);
    const stored = (bodies[0]?.execution_trace?.tasks ?? bodies[0]?.tasks ?? []) as Array<{ resolver_id?: string; resolver_tier?: string }>;
    expect(stored.map((t) => `${t.resolver_id}/${t.resolver_tier}`)).toEqual(["fs_grep/deterministic", "llm_completion_dispatch/llm", "llm_completion_dispatch/llm"]);
    expect(stored.every((t) => t.resolver_tier === "deterministic")).toBe(false);
  });

  test("[WIRING] the floor persists its trace through floorTraceTasks with the loop's decisions", () => {
    expect(SRC).toContain("tasks: floorTraceTasks(executed, decisions, floorReached),");
    expect(SRC).toContain("const { groundedOk, executedOk, executed, observations, calledWriteShapes, commandEvidence, decisions } = loop;");
  });
});
