// THE FLOOR OFFERS AND CALLS web_search AND bounded_shell; THE GENERAL SHELLS STAY REFUSED.
//
// User ruling 2026-10-26T19:05:13Z, "Shell on the floor now anyway": offer bounded_shell on the floor as it is,
// accepting the containment gap (local-tools' containment is lexical only). It supersedes the 10-16 no-shell ruling
// for bounded_shell. Before it, the floor's offer was the read tools alone: a world-fact goal could only say it cannot
// retrieve the fact, and a goal needing a computed answer could only say it cannot measure it.
//
//   [MUST-FAIL] a world-fact goal: the floor's offer (built the floor's way from what discovery advertises) carries
//               web_search, the model's web_search call is executed through its resolver and grounds the answer.
//   [MUST-FAIL] a goal needing a computed answer: the offer carries bounded_shell, the call is executed with the
//               model's command, grounds the answer, and lands in the command evidence.
//   [CONTROL]   shellResult, shell and bash are never offered and a model call to any of them is refused before
//               egress ("tool not authorized"), as is an fs_write call (the write doors are unchanged).
//
// Goals come from fresh 5-word draws (draw-words.sh):
//   A 2026-10-26T19:12:24Z seed=1793041944237128439 words=slobbery storeroom manmade google reunite
//   B 2026-10-26T19:12:24Z seed=1793041944260631930 words=frigidly jockstrap overall crazed rekindle
//
// runGroundedToolLoop is DRIVEN with fetch spied (restored after), as in floor-server-executed-tools.test.ts: the
// resolvers are fixtures, no command runs. Import is dynamic for the reason given in index-pure-exports.test.ts.
import { afterEach, describe, expect, spyOn, test } from "bun:test";

process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
const m = await import("../src/index") as any;
const ft = (await import("../src/floor-tools")) as Record<string, any>;

const GOAL_A = "Which man-made material do conservators recommend for storing reunited family keepsakes in a damp storeroom, safe from slobbery pets? Look it up the way you would with google.";
const GOAL_B = "Overall, how many letters do the words frigidly, jockstrap, crazed and rekindle contain together?";
const DISPATCH_VESSEL = { id: "dispatch-vessel", endpoint: "http://llm-dispatch.test.invalid", resolve_endpoint: "/v2/impulses/resolve", protocol: "http" };
const TOOLS_VESSEL = { id: "local-tools-vessel", endpoint: "http://local-tools.test.invalid", resolve_endpoint: "/resolve", protocol: "http" };
const SERVED = new Set(["web_search", "bounded_shell", "shellResult", "shell", "bash", "fs_write"]);
const KNOWN = new Set(["fs_read", "codeSearchResult", "fs_grep", "substrateGap", "web_search", "bounded_shell", "shellResult", "shell", "bash", "fs_write"]);
const GENERAL_SHELLS = ["shellResult", "shell", "bash"];

/** The floor's offer, built as universalToolFallback builds it: its list filtered by what discovery advertises. */
function floorOffer(): any[] {
  const list: any[] = ft["UNIVERSAL_FLOOR_TOOLS"] ?? ft["UNIVERSAL_READ_TOOLS"];
  const hand = new Set(ft["floorHandToolNames"](KNOWN));
  return list.filter((t) => hand.has(t.name));
}

let spy: ReturnType<typeof spyOn> | null = null;
afterEach(() => { spy?.mockRestore(); spy = null; });

/** Drive the loop: turn 1 makes `calls`, turn 2 answers `answer`. `results` answers each tool shape's resolve. */
async function drive(goal: string, calls: Array<{ tool_name: string; tool_input: Record<string, unknown> }>, results: Record<string, unknown>, answer: string) {
  let turn = 0;
  const offered: string[][] = [];
  const resolved: Array<Record<string, any>> = [];
  spy = spyOn(globalThis, "fetch").mockImplementation((async (_i: unknown, init?: { body?: unknown }) => {
    let b: any = {};
    try { b = JSON.parse(String(init?.body ?? "{}")); } catch { /* not JSON */ }
    if (b?.pointer?.type === "vesselCapability") {
      const s = b.pointer.shape;
      return Response.json({ content: { vessels: s === "llm_completion_dispatch" ? [DISPATCH_VESSEL] : SERVED.has(s) ? [TOOLS_VESSEL] : [] } });
    }
    const p = b?.impulse?.pointer;
    if (p?.type === "llm_completion_dispatch") {
      turn++;
      offered.push((p.tools ?? []).map((t: any) => String(t?.name)));
      return Response.json(turn === 1
        ? { success: true, shape: "llmTextCompletion", body: { text: "", tool_calls: calls } }
        : { success: true, shape: "llmTextCompletion", body: { text: answer } });
    }
    if (p && SERVED.has(p.type)) { resolved.push(p); return Response.json({ success: true, content: results[p.type] ?? { note: "unexpected" } }); }
    return new Response("not served by this fixture", { status: 503 });
  }) as unknown as typeof fetch);
  const loop = await m.runGroundedToolLoop(`GOAL: ${goal}`, floorOffer(), []);
  return { loop: loop!, offered, resolved };
}

describe("the floor offers web_search and bounded_shell (user ruling 2026-10-26T19:05:13Z)", () => {
  test("[MUST-FAIL] draw A, a world-fact goal: web_search is offered, called through its resolver, and grounds the answer", async () => {
    const hit = { title: "Storing family keepsakes", url: "https://example.org/conservation/keepsakes", snippet: "Use acid-free polyester (PET) sleeves and polypropylene boxes; avoid damp storerooms." };
    const { loop, offered, resolved } = await drive(GOAL_A, [{ tool_name: "web_search", tool_input: { query: "man-made material conservators recommend storing keepsakes damp storeroom" } }],
      { web_search: { shape: "webSearchResult", query: "q", results: [hit], retrieved_at: "2026-10-26T19:12:24Z", provider: "fixture" } },
      "Polyester (PET) sleeves and polypropylene boxes, per https://example.org/conservation/keepsakes.");
    expect(offered[0]).toContain("web_search");
    expect(resolved.map((p) => p.type)).toEqual(["web_search"]);
    expect(resolved[0]!.query).toBe("man-made material conservators recommend storing keepsakes damp storeroom");
    expect(loop.executed).toEqual([{ tool: "web_search", ok: true }]);
    expect(loop.groundedOk).toBe(1);
    expect(loop.observations.some((o: string) => o.includes("https://example.org/conservation/keepsakes"))).toBe(true);
    expect(loop.finalText).toContain("polypropylene");
    // the prompt the floor builds from this offer says web_search is the way to world facts
    const lines = ft["floorPromptToolLines"](new Set(offered[0]));
    expect(lines.world).toContain("call web_search");
    expect(lines.world).not.toContain("NO internet");
  });

  test("[MUST-FAIL] draw B, a goal needing a computed answer: bounded_shell is offered, called with the command, and grounds it", async () => {
    const command = "printf %s frigidlyjockstrapcrazedrekindle | wc -m";
    const { loop, offered, resolved } = await drive(GOAL_B, [{ tool_name: "bounded_shell", tool_input: { command } }],
      { bounded_shell: { shape: "boundedShellResult", stdout: "31\n", stderr: "", exit_code: 0 } },
      "Together they contain 31 letters (measured with bounded_shell: wc -m printed 31).");
    expect(offered[0]).toContain("bounded_shell");
    expect(resolved.map((p) => p.type)).toEqual(["bounded_shell"]);
    expect(resolved[0]!.command).toBe(command);
    expect(loop.executed).toEqual([{ tool: "bounded_shell", ok: true }]);
    expect(loop.groundedOk).toBe(1);
    expect(loop.commandEvidence).toContain(`bounded_shell was RUN as: \`${command}\``);
    expect(loop.observations.some((o: string) => o.includes("\"stdout\":\"31\\n\""))).toBe(true);
    const lines = ft["floorPromptToolLines"](new Set(offered[0]));
    expect(lines.shell).toContain("bounded_shell");
    expect(lines.shell).toContain("nothing may be written except through a write tool offered below");
    expect(lines.compute).toContain("bounded_shell");
  });
});

describe("[CONTROL] the general shells and the write doors are unchanged", () => {
  test("shellResult, shell, bash and fs_write are not offered, and a model call to each is refused before egress", async () => {
    const calls = [...GENERAL_SHELLS, "fs_write"].map((t) => ({ tool_name: t, tool_input: t === "fs_write" ? { path: "/workspace/git/super-repo/x.md", content: "x" } : { command: "echo frigidly" } }));
    const { loop, offered, resolved } = await drive(GOAL_B, calls, {}, "I could not run those.");
    for (const t of [...GENERAL_SHELLS, "fs_write"]) expect(offered[0]).not.toContain(t);
    expect(resolved).toEqual([]);
    expect(loop.executed).toEqual([...GENERAL_SHELLS, "fs_write"].map((t) => ({ tool: t, ok: false })));
    expect(loop.groundedOk).toBe(0);
    for (const t of [...GENERAL_SHELLS, "fs_write"]) expect(loop.observations).toContain(`TOOL ${t} ERROR: tool not authorized`);
  });

  test("the general shells stay forbidden as target tools", () => {
    expect([...ft["FLOOR_FORBIDDEN_TOOLS"]]).toEqual(expect.arrayContaining(GENERAL_SHELLS));
    expect(ft["floorTargetCandidates"](GENERAL_SHELLS, KNOWN, new Set())).toEqual([]);
  });
});

describe("the floor prompt's tool statements follow the offer", () => {
  test("a node that advertises neither tool keeps the prompt's honest refusals", () => {
    const none = ft["floorPromptToolLines"](new Set(["fs_read", "codeSearchResult"]));
    expect(none.world).toContain("NO internet tool");
    expect(none.shell).toContain("NO shell tool");
    expect(none.compute).toContain("cannot be measured with these tools");
  });
});
