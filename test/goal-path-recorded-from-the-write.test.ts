// Rows: the-dispatch-record-says-goal-path-recorded-under-observe-although-no-goal-path-is-written (KNOWN-WRONG 16),
// with a-successful-goal-path-record-logs-nothing-and-the-recorded-flag-is-set-before-the-post-settles.
//
// The walk set learningSink.goalPathRecorded = true by reaching the line, outside the guard on the write: an
// observe walk (which writes no path) and an abstaining walk both reported a recorded goal path, and a rejected
// write did too. The flag is now set from recordGoalPath's own result, which is true only on a 2xx.
//
// recordGoalPath is driven in a CHILD process (test/fixtures/goal-path-record-result-child.ts) against a loopback
// stub; the walk needs a live host, so its wiring is pinned on the source.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
const walkEnd = (() => { const i = SRC.indexOf("recordGoalPath PRECONDITIONS chain="); return i >= 0 ? SRC.slice(i, SRC.indexOf("// Adapt the last ExecutionTrace into the GoalRunResult shape", i)) : ""; })();
const bridge = (() => { const i = SRC.indexOf("const durableOutputRequested = goalRequestsDurableArtifact(goal);"); return i >= 0 ? SRC.slice(i, SRC.indexOf("if (shouldBridge) {", i) + 20) : ""; })();
const CHILD = join(import.meta.dir, "fixtures", "goal-path-record-result-child.ts");
const MARK = "GOAL_PATH_RESULT_RESULT ";
interface ChildResult { exposed: boolean; cases: Array<{ goal: string; resolved: unknown; posts: number }>; refused: string[]; error?: string }
let res: ChildResult;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "goal-path-result-"));
  try {
    const p = Bun.spawn([process.execPath, CHILD], { cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home, NODE_ENV: "test", TZ: "UTC" }, stdout: "pipe", stderr: "pipe" });
    const kill = setTimeout(() => p.kill(), 60_000);
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(kill);
    const line = stdout.split("\n").find((l) => l.startsWith(MARK));
    if (!line) throw new Error(`the child printed no result (rc ${p.exitCode}): ${stderr.slice(-800)}`);
    res = JSON.parse(line.slice(MARK.length)) as ChildResult;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 90_000);

describe("MUST-FAIL: goalPathRecorded says a path was written only when it was", () => {
  test("recordGoalPath resolves true on a 2xx, false on a rejected write and when there is no path", () => {
    expect(res.error).toBeUndefined();
    expect(res.exposed).toBe(true);
    const [ok, rejected, empty] = res.cases;
    expect(ok).toEqual({ goal: ok!.goal, resolved: true, posts: 1 });
    expect(rejected).toEqual({ goal: rejected!.goal, resolved: false, posts: 1 });
    expect(empty!.resolved).toBe(false);
  });

  test("the walk sets the flag only from that result, at both record sites, and nowhere unconditionally", () => {
    const set = "opts.learningSink.goalPathRecorded = true";
    const fromResult = ".then((ok) => { if (ok && opts.learningSink) opts.learningSink.goalPathRecorded = true; }, () => {});";
    expect(walkEnd.split(set).length - 1).toBe(2);
    expect(walkEnd.split(fromResult).length - 1).toBe(2);
    // the observe-guarded and the traceless writes are the two that carry it
    expect(walkEnd).toContain('if (opts.learningMode !== "observe" && !walkAbstain) void recordGoalPath(goal, chain, reached,');
    expect(walkEnd).toContain("if (!walkAbstain) void recordGoalPath(goal, chain, reached,");
    expect(walkEnd.includes("if (opts.learningSink) opts.learningSink.goalPathRecorded = true;")).toBe(false);
  });
});

describe("CONTROL: a walk records and bridges as before", () => {
  test("a written path is recorded (resolves true) and posts exactly once", () => {
    expect(res.cases[0]!.resolved).toBe(true);
    expect(res.cases[0]!.posts).toBe(1);
    expect(res.refused).toEqual([]);
  });

  test("the bridge's own conditions are unchanged, and the write calls keep their guards", () => {
    expect(bridge).toContain("const bridgeNotes = isObsidianSurface || durableOutputRequested;");
    expect(bridge).toContain("const shouldBridge = reached === true && (bridgeNotes || verdict?.deterministic === true);");
    expect(SRC.match(/void recordGoalPath\(goal, chain, reached,/g) ?? []).toHaveLength(2);
    expect(SRC).toContain('if (opts.learningMode !== "observe" && goal && selId && !attemptAbstained) void recordGoalPath(goal, [selId], reached,');
  });
});
