// THE WALK ACTIVITY ACROSS EVERY VERDICT-DIFF SCENARIO (hermetic: the harness child runs the REAL src/index.ts with fetch
// stubbed and every outbound request recorded). The walk is an engine execution, so the executor's lifecycle subscribers
// (validator-dispatch, slot-binding) run on it. This pins that none of those runs ever starts a walk, that no walk is
// refused as nested, and that the walk executions are exactly the dispatcher's: one first walk per walked dispatch plus
// one per retry (feedback / suppress / reframe), each retry parented to its first walk.
// MUST-FAIL before the walk was an activity (no walk execution exists, so the total below is 0).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listScenarios, runAll } from "./judge-split/verdict-diff/runner";

const TREE = resolve(import.meta.dir, "..");
const HERMETIC = !existsSync("/workspace") && !existsSync("/vessels");
const WALK = "goal-host-vessel:walk";

interface Rec { url: string; route?: string; body?: Record<string, unknown> }

describe.skipIf(!HERMETIC)("the walk activity in every verdict-diff scenario", () => {
  test("no subscriber run starts a walk; no nested-walk refusal; walk executions = first walks + retries", async () => {
    const ids = listScenarios();
    expect(ids.length).toBe(72);
    const results = await runAll(TREE, ids);
    let total = 0;
    const problems: string[] = [];
    for (const r of results) {
      const out = JSON.parse(r.json) as { fatal?: string; requests?: Rec[] };
      if (out.fatal) { problems.push(`${r.id}: fatal ${out.fatal}`); continue; }
      const traces = (out.requests ?? []).filter((q) => q.route === "default:trace-write" && q.body).map((q) => q.body!);
      const walks = traces.filter((t) => t["template_id"] === WALK);
      const nonWalkIds = new Set(traces.filter((t) => t["template_id"] !== WALK).map((t) => String(t["execution_id"])));
      const walkIds = new Set(walks.map((t) => String(t["execution_id"])));
      const logs = r.log ? ((JSON.parse(r.log) as { logs?: string[] }).logs ?? []) : [];
      const dispatched = logs.map((l) => /walk-activity: dispatched (\S+) parent=(\S+)/.exec(l)).filter((m): m is RegExpExecArray => m !== null);
      const retries = logs.map((l) => /walk-retry tap: retry=(\w+) first_walk=(\S+) retry_walk=(\S+)/.exec(l)).filter((m): m is RegExpExecArray => m !== null);
      total += walks.length;
      for (const w of walks) {
        const parent = w["parent_execution_id"];
        if (typeof parent === "string" && nonWalkIds.has(parent)) problems.push(`${r.id}: walk ${String(w["execution_id"])} started under a non-walk execution ${parent}`);
        if (/nested walk/.test(JSON.stringify(w))) problems.push(`${r.id}: nested-walk refusal ${String(w["execution_id"])}`);
      }
      if (logs.some((l) => /is a nested walk, and nesting is off/.test(l))) problems.push(`${r.id}: a nested-walk refusal was logged`);
      const dispatchedIds = new Set(dispatched.map((m) => m[1]!));
      if (dispatchedIds.size !== dispatched.length) problems.push(`${r.id}: a walk id was dispatched twice`);
      if ([...walkIds].some((id) => !dispatchedIds.has(id)) || [...dispatchedIds].some((id) => !walkIds.has(id))) problems.push(`${r.id}: walk executions [${[...walkIds]}] != dispatcher's walks [${[...dispatchedIds]}]`);
      const firstWalks = dispatched.filter((m) => !dispatchedIds.has(m[2]!)).length;
      if (walks.length !== firstWalks + retries.length) problems.push(`${r.id}: ${walks.length} walk executions != ${firstWalks} first walks + ${retries.length} retries`);
      for (const m of retries) {
        const child = walks.find((w) => w["execution_id"] === m[3]);
        if (!child || child["parent_execution_id"] !== m[2] || !dispatchedIds.has(m[2]!)) problems.push(`${r.id}: retry ${m[1]} ${m[3]} is not parented to its first walk ${m[2]}`);
      }
    }
    expect(problems).toEqual([]);
    expect(total).toBeGreaterThan(0);
  }, 900_000);
});
