// THE GOAL-PATH RECORD CARRIES THE REACH VERDICT AS `reached`, BESIDE `success`.
//
// recordGoalPath posts every walk's path to activity-api POST /v2/goal-paths. It sent the walk's reach verdict only as
// `success`. The receiver is moving to grade a path (its counters and α/β) only when the body carries an explicit
// `reached` boolean: an absent `reached` is ungraded and writes nothing. A receiver that lands before this sender would
// black out goal-path learning, so the sender sends the verdict under both names first. The current receiver's schema
// is non-strict and drops a key it does not know, so sending it early changes nothing there.
//
//   [MUST-FAIL] the body recordGoalPath posts carries `reached` as a boolean equal to the walk's verdict (true, false).
//   [CONTROL]   the same body still carries `success` equal to the verdict, on both sides.
//
// recordGoalPath is module-private. test/fixtures/goal-path-record-child.ts exposes it with a loader plugin and drives
// it against a loopback stub. That runs in a CHILD bun process: the plugin applies only to a module not yet loaded, and
// in a one-process suite another file has usually imported src/index.ts first. The child gets a fixed env (PATH, a
// scratch HOME, NODE_ENV, TZ), refuses every fetch outside its stub, and prints one structured result line.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "fixtures", "goal-path-record-child.ts");
const MARK = "GOAL_PATH_RECORD_RESULT ";

interface Case { goal: string; reached: boolean; posts: number; body: Record<string, unknown> | null }
interface ChildResult { exposed: boolean; cases: Case[]; refused: string[]; error?: string }
let res: ChildResult;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "goal-path-record-"));
  try {
    const p = Bun.spawn([process.execPath, CHILD], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, NODE_ENV: "test", TZ: "UTC" },
      stdout: "pipe", stderr: "pipe",
    });
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

/** The one POST /v2/goal-paths body the child captured for the case with this verdict and control flag. */
function bodyFor(reached: boolean, control: boolean): Record<string, unknown> {
  const c = res.cases.find((x) => x.reached === reached && x.goal.endsWith("(control)") === control);
  expect(c).toBeDefined();
  expect(c!.posts).toBe(1);
  expect(c!.body).not.toBeNull();
  expect(c!.body!["goal_text"]).toBe(c!.goal);
  return c!.body!;
}

describe("the goal-path record carries the walk's reach verdict as `reached`", () => {
  test("the module exposes recordGoalPath through the loader plugin", () => {
    expect(res.error).toBeUndefined();
    expect(res.exposed).toBe(true);
    expect(res.cases.length).toBe(4);
  });

  test("[MUST-FAIL] a reached walk posts reached: true", () => {
    const body = bodyFor(true, false);
    expect(typeof body["reached"]).toBe("boolean");
    expect(body["reached"]).toBe(true);
  });

  test("[MUST-FAIL] a walk that did not reach posts reached: false", () => {
    const body = bodyFor(false, false);
    expect(typeof body["reached"]).toBe("boolean");
    expect(body["reached"]).toBe(false);
  });

  test("[CONTROL] success is unchanged: it still equals the verdict, on both sides", () => {
    expect(bodyFor(true, true)["success"]).toBe(true);
    expect(bodyFor(false, true)["success"]).toBe(false);
  });

  test("[CONTROL] no request left the loopback stub", () => {
    expect(res.refused).toEqual([]);
  });
});
