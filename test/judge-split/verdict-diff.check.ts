// VERDICT DIFF (BUILD 7 DESIGN §4.2): every scenario in test/judge-split/verdict-diff/scenarios is replayed
// hermetically against THIS tree's src/index.ts (stub fetch and spawn, virtual clock, seeded ids;
// see test/judge-split/verdict-diff/child.ts), and its canonical record — the ordered outbound requests (every
// sink write, resolve and LLM call), the spawns, and each step's verdict — must equal the golden
// committed in test/judge-split/verdict-diff/golden byte for byte.
//
// WHY. The judge/walk split moves ~8,000 lines of judging code out of index.ts and turns ~40 inline
// closures into parameters. "Identical verdicts" is then a claim unless a replay of the same inputs
// shows the same writes in the same order. The golden is generated on the BASE tree (run.ts generate)
// and never edited by hand; a difference here is a behaviour change, whatever its size.
//
// HOST-SIDE MOVE-EQUIVALENCE TOOL, NOT ADMISSION. It refuses to run where /workspace or /vessels exists (the
// container), and its golden pins one bun and executor build, so it is a `.check.ts`: never in the gate suite,
// never a protected test. Admission is the verdict corpus (test/verdict-corpus/). Run it on purpose:
//   bun test ./test/judge-split/verdict-diff.check.ts
//
// A failure names the scenario and the first differing line. To localize it:
//   bun test/judge-split/verdict-diff/run.ts out /tmp/a --tree <base>   &&   bun test/judge-split/verdict-diff/run.ts out /tmp/b
//   diff -r /tmp/a /tmp/b        (the .log.json files carry each run's captured console)
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENVIRONMENT_PATH, GOLDEN_DIR, environmentOf, firstDiff, listScenarios, runAll } from "./verdict-diff/runner";

const TREE = join(import.meta.dir, "..", "..");
const ids = listScenarios();
// The golden records the bun version and the executor build it was generated under (runner.ts
// environmentOf). The byte test is pinned to the executor VERSION only: a different build of the same
// version prints a warning naming both fingerprints and the byte comparison STILL RUNS. A diff caused
// by a build change is then a rare false failure, never a false pass. A different executor VERSION
// (or bun) FAILS the byte test, naming the difference: a runtime this check cannot judge is a failure,
// never a skip (a silent skip reads as a pass).
const thisEnvObj = environmentOf(TREE);
const goldenEnvObj = (existsSync(ENVIRONMENT_PATH) ? JSON.parse(readFileSync(ENVIRONMENT_PATH, "utf8")) : {}) as Partial<ReturnType<typeof environmentOf>>;
const sameVersion = thisEnvObj.ias_executor_version === goldenEnvObj.ias_executor_version && thisEnvObj.bun === goldenEnvObj.bun;
if (thisEnvObj.ias_executor_dist_sha256 !== goldenEnvObj.ias_executor_dist_sha256 || !sameVersion) {
  console.warn(`[verdict-diff] environment differs from the golden's${sameVersion ? " (same executor version: byte comparison still runs)" : " (executor version or bun differs: the byte comparison FAILS, it cannot judge this runtime)"}\n  golden: ${JSON.stringify(goldenEnvObj)}\n  this:   ${JSON.stringify(thisEnvObj)}`);
}

describe("verdict diff: hermetic replay of the walk/judge corpus equals the committed golden", () => {
  test("the corpus is non-trivial and every scenario has a golden", () => {
    expect(ids.length).toBeGreaterThanOrEqual(60);
    const missing = ids.filter((id) => !existsSync(join(GOLDEN_DIR, `${id}.json`)));
    expect(missing).toEqual([]);
  });

  let results: Awaited<ReturnType<typeof runAll>> | null = null;
  const replay = async () => (results ??= await runAll(TREE, ids));

  test("every scenario replays to completion (no harness fatal, no runaway guard, no abort)", async () => {
    const failures: string[] = [];
    for (const r of await replay()) {
      const parsed = JSON.parse(r.json) as { fatal?: string; harness?: { aborted?: string | null } };
      if (parsed.fatal) failures.push(`${r.id}: harness fatal — ${parsed.fatal.slice(0, 400)}\n${r.stderr.slice(-800)}`);
      else if (parsed.harness?.aborted) failures.push(`${r.id}: harness aborted — ${parsed.harness.aborted}`);
    }
    expect(failures).toEqual([]);
  }, 600_000);

  test("every scenario replays to its golden, byte for byte", async () => {
    if (!sameVersion) throw new Error(`cannot judge this runtime: the golden was generated under ${JSON.stringify(goldenEnvObj)}, this is ${JSON.stringify(thisEnvObj)}`);
    const failures: string[] = [];
    for (const r of await replay()) {
      const golden = readFileSync(join(GOLDEN_DIR, `${r.id}.json`), "utf8");
      const d = firstDiff(golden, r.json);
      if (d) failures.push(`${r.id}: differs from golden at ${d}`);
    }
    expect(failures).toEqual([]);
  }, 600_000);

  test("a golden is a completed replay: no fatal, no abort, every step driven to completion", () => {
    const bad: string[] = [];
    for (const id of ids) {
      const p = join(GOLDEN_DIR, `${id}.json`);
      if (!existsSync(p)) continue;
      const g = JSON.parse(readFileSync(p, "utf8")) as { fatal?: string; harness?: { aborted?: string | null }; steps?: Array<{ step: number; drive?: string | null }> };
      if (g.fatal) bad.push(`${id}: fatal`);
      if (g.harness?.aborted) bad.push(`${id}: aborted`);
      for (const s of g.steps ?? []) if (s.drive && s.drive !== "done") bad.push(`${id} step ${s.step}: drive=${s.drive}`);
    }
    expect(bad).toEqual([]);
  });
});
