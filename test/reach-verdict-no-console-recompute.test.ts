// A REACH VERDICT IS GRADED ONLY BY WHAT IT POSTS. An autonomous landing (gap route-edit-ef0da725) added a "deterministic
// independent recompute" to deliverReachVerdict: for a reason naming deterministic_independent_recompute_disagrees it
// hashed the GOAL HASH (not the walk's input) and printed "oracle disagrees/confirms" to the console. Nothing read the
// line and nothing was graded by it, so it claimed an oracle verdict the learning loop never saw. That code is removed:
// the verdict a delivery makes is the POST /reach body, and no console-only oracle line stands beside it.
//
// Import is dynamic for the reason given in index-pure-exports.test.ts. fetch and console are spied and restored.
import { describe, expect, test, spyOn } from "bun:test";

process.env["LLM_VESSEL_ENDPOINT"] ||= "http://127.0.0.1:8220";
const { deliverReachVerdict } = await import("../src/index");

const REASON = "deterministic:deterministic_independent_recompute_disagrees produced=00ff00ff00ff00ff";

async function delivered(run: () => void): Promise<{ bodies: Array<Record<string, unknown>>; lines: string[] }> {
  const bodies: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  const spies = [
    spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/execution-traces/reach")) bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 400 });
    }) as typeof fetch),
    ...(["log", "info", "warn"] as const).map((m) => spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); })),
  ];
  try {
    run();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return { bodies, lines };
}

describe("deliverReachVerdict: no console-only recompute", () => {
  test("[MUST-FAIL] a recompute-class reason prints no ungraded 'oracle' line", async () => {
    const { lines } = await delivered(() => deliverReachVerdict("exec_recompute_1", false, [], "walk-complete", REASON, "abc123"));
    expect(lines.filter((l) => l.includes("deterministic_independent_recompute_disagrees") && /oracle/.test(l))).toEqual([]);
  });
  test("[CONTROL] the graded path is unchanged: the POST /reach body carries the verdict, reason and goal hash", async () => {
    const { bodies } = await delivered(() => deliverReachVerdict("exec_recompute_2", false, [], "walk-complete", REASON, "abc123"));
    expect(bodies).toEqual([{ execution_id: "exec_recompute_2", reached: false, completion_shapes: [], reason: REASON, goal_hash: "abc123" }]);
  });
});
