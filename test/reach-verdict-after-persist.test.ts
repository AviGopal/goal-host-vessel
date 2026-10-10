// THE REACH VERDICT IS DELIVERED AFTER THE ROW IT GRADES EXISTS (OP-1 c).
//
// Measured (diag-1b1c): the walk persisted its durable satisfier trace fire-and-forget
// (`void persistSatisfierTrace(durableTrace)`), returned, and the dispatch handler then delivered the walk-complete
// verdict with deliverReachVerdict. The two raced: POST /reach matched no row in ~24% of satisfier-last walks.
// And drainReachSpool RETIRED a spooled entry that came back {updated:0}, on the theory that a matched-no-row
// never lands later — which is exactly what a lost race does.
//
// THE RULES PINNED HERE:
//   - the walk AWAITS the durable persist, and the handler delivers only after the walk (runGoalWithRecovery)
//     resolved — so delivery follows persistence. The walk needs a live host, so this order is pinned on the
//     source, as the flush-order test pins its wiring;
//   - drainReachSpool keeps an {updated:0} entry for a bounded number of retries (selection-tuning
//     reachSpoolNoRowRetries), sends it without its private try count, and retires it after the bound.
//
// Hermetic: the spool is a temp file handed to drainReachSpool (its path seam; the module-level default is read
// once, by whichever test file imports index.ts first), WORKSPACE_ROOT is a temp dir, and fetch is stubbed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "op1-reach-spool-"));
const SPOOL = join(root, "reach-verdict-spool.jsonl");
const prevRoot = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = root;
process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";

const realFetch = globalThis.fetch;
const reachBodies: string[] = [];
let reachAnswer: () => Response = () => new Response(JSON.stringify({ updated: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
let mod: Record<string, any>;
beforeAll(async () => {
  globalThis.fetch = ((input: unknown, init?: { body?: unknown }) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v2/activities/execution-traces/reach")) { reachBodies.push(String(init?.body ?? "")); return Promise.resolve(reachAnswer()); }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as unknown as typeof fetch;
  mod = (await import("../src/index")) as Record<string, any>;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
function fnBody(name: string): string {
  const i = SRC.search(new RegExp(`\\nasync function ${name}\\(`));
  expect(i).toBeGreaterThan(-1);
  const j = SRC.indexOf("\nasync function ", i + 10);
  return SRC.slice(i, j > i ? j : undefined);
}
const BODY = (id: string) => JSON.stringify({ execution_id: id, reached: true, completion_shapes: ["report"] });
const spoolLines = (): string[] => readFileSync(SPOOL, "utf8").split("\n").filter((l) => l.trim());

describe("MUST-FAIL — delivery follows persistence", () => {
  test("the walk awaits the durable satisfier persist (no fire-and-forget)", () => {
    const walk = fnBody("runGoalAsPoolWalkBody");
    const persist = walk.slice(walk.indexOf("if (satisfierOnlyTrace) {"));
    expect(persist).toContain("await persistSatisfierTrace(durableTrace);");
    expect(SRC).not.toContain("void persistSatisfierTrace(durableTrace)");
  });

  test("the walk-complete delivery runs only after the walk (runGoalWithRecovery) resolved", () => {
    const handler = fnBody("handleRunGoal");
    const walked = handler.indexOf("const seek = await runGoalWithRecovery(goal, {");
    const delivered = handler.indexOf('deliverReachVerdict(record.executionId, record.reached, seek.completionShapes, "walk-complete"');
    expect(walked).toBeGreaterThan(-1);
    expect(delivered).toBeGreaterThan(walked);
  });
});

describe("MUST-FAIL — a spooled verdict that matched no row is kept, bounded", () => {
  test("updated:0 is NOT retired: it stays spooled with a try count, and is sent without it", async () => {
    reachBodies.length = 0;
    reachAnswer = () => new Response(JSON.stringify({ updated: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
    writeFileSync(SPOOL, BODY("walk-satisfier-2-1") + "\n");
    await mod.drainReachSpool(SPOOL);
    const kept = spoolLines();
    expect(kept.length).toBe(1);
    expect(JSON.parse(kept[0]!).execution_id).toBe("walk-satisfier-2-1");
    expect(JSON.parse(kept[0]!).__no_row_tries).toBe(1);
    expect(reachBodies).toEqual([BODY("walk-satisfier-2-1")]); // the private field never reaches /reach
  });

  test("…and is retired after reachSpoolNoRowRetries tries (default 5), not kept forever", async () => {
    for (let i = 0; i < 6; i++) await mod.drainReachSpool(SPOOL);
    expect(spoolLines()).toEqual([]);
    expect(reachBodies.length).toBe(5); // 1 above + 4 more, then retired on the 5th
  });

  test("CONTROL: a matched row retires the entry; a transport failure keeps it as it was", async () => {
    reachAnswer = () => new Response(JSON.stringify({ updated: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
    writeFileSync(SPOOL, BODY("walk-satisfier-3-1") + "\n");
    await mod.drainReachSpool(SPOOL);
    expect(spoolLines()).toEqual([]);
    reachAnswer = () => { throw new Error("Unable to connect"); };
    writeFileSync(SPOOL, BODY("walk-satisfier-4-1") + "\n");
    await mod.drainReachSpool(SPOOL);
    expect(spoolLines()).toEqual([BODY("walk-satisfier-4-1")]);
  });
});
