// THE REACH VERDICT NAMES THE CONCEPTS ITS DISPATCH RECALLED (dispatch-context.ts recall record, reachVerdictBody).
//
// concept-db keys a walk's recall by the DISPATCH id its search named (concept-recall-pointer.ts), while the reach
// verdict, and so activity-api's execution_completed, names the TRACE id: the two never met, and no recalled concept
// was credited by the verdict it informed. The POST /reach body now carries `recalled_concept_ids`: the ids THIS
// dispatch's recalls returned, read from its own dispatch-context record (begun at the /run-goal root entry, shared by
// every re-entry below it), deduplicated and capped at 50, and ABSENT when it recalled none.
//
// The dispatch runs in a CHILD process (test/fixtures/reach-recalled-concepts-child.ts) that exposes the module-private
// recall, drives it and the REAL deliverReachVerdict against a loopback stub, and records each POST /reach body.
//   [MUST-FAIL] a dispatch that recalled concepts posts /reach with exactly those ids (deduplicated, in recall order),
//               even from the cost re-entry that runs under a different id; an in-process dispatch nested inside
//               another carries only its own, and the outer only its own; 60 recalled ids are capped at 50.
//   [CONTROL]   a dispatch that recalled nothing sends no field (absent, not []); a store no root began, and a delivery
//               outside any dispatch, send none; with no ids the body is today's, byte for byte.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["LLM_VESSEL_ENDPOINT"] ||= "http://127.0.0.1:8220";
const { reachVerdictBody } = await import("../src/index");
const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

const CHILD = join(import.meta.dir, "fixtures", "reach-recalled-concepts-child.ts");
const MARK = "REACH_RECALLED_RESULT ";
let res: { exposed: boolean; rootBegins: boolean; reach: Record<string, Record<string, unknown>>; refused: string[]; error?: string };
const body = (id: string): Record<string, unknown> => { expect(res.reach[id]).toBeDefined(); return res.reach[id]!; };

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "reach-recalled-"));
  try {
    const p = Bun.spawn([process.execPath, CHILD], { cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home, NODE_ENV: "test", TZ: "UTC" }, stdout: "pipe", stderr: "pipe" });
    const kill = setTimeout(() => p.kill(), 90_000);
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(kill);
    const line = stdout.split("\n").find((l) => l.startsWith(MARK));
    if (!line) throw new Error(`the child printed no result (rc ${p.exitCode}): ${stderr.slice(-800)}`);
    res = JSON.parse(line.slice(MARK.length));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

describe("MUST-FAIL: a walk that recalled concepts posts /reach with exactly those ids", () => {
  test("the child ran the real recall and delivery", () => {
    expect(res.error).toBeUndefined();
    expect(res.exposed).toBe(true);
    expect(res.refused).toEqual([]);
  });
  test("two recalls, one id shared, delivered from a re-entry under another id: exactly those ids, deduplicated", () => {
    const b = body("trace-recalled");
    expect(b["reached"]).toBe(true);
    expect(b["recalled_concept_ids"]).toEqual(["concept:concept_a1", "concept:concept_shared", "concept:concept_b1"]);
  });
  test("a dispatch nested inside another carries only its own recalls, and the outer only its own", () => {
    expect(body("trace-inner")["recalled_concept_ids"]).toEqual(["concept:concept_c1"]);
    expect(body("trace-outer")["recalled_concept_ids"]).toEqual(["concept:concept_a1", "concept:concept_shared"]);
  });
  test("60 recalled ids are capped at 50", () => {
    expect(body("trace-many")["recalled_concept_ids"]).toEqual(Array.from({ length: 50 }, (_, i) => `concept:concept_m${i}`));
  });
  test("the /run-goal root entry begins the record right after it enters the dispatch context", () => {
    expect(res.rootBegins).toBe(true);
    const i = SRC.indexOf("dispatchContext.enterWith(enterDispatchContext(dispatchContext.getStore(), { dispatchId, learningMode }));");
    expect(i).toBeGreaterThan(0);
    expect(SRC.indexOf("beginRecallRecord(dispatchContext.getStore());", i)).toBeGreaterThan(i);
    expect(SRC.indexOf("beginRecallRecord(dispatchContext.getStore());", i)).toBeLessThan(SRC.indexOf("const seek = await runGoalWithRecovery(goal, {", i));
  });
  test("reachVerdictBody dedupes, drops non-strings and caps", () => {
    const many = [...Array.from({ length: 55 }, (_, i) => `c${i}`), "c0", "", 7 as unknown as string];
    const b = JSON.parse(reachVerdictBody("exec_1", true, ["shellResult"], "ok", "h1", undefined, null, many));
    expect(b.recalled_concept_ids).toEqual(Array.from({ length: 50 }, (_, i) => `c${i}`));
  });
});

describe("CONTROL: a walk with no recalls sends none (absent, not [])", () => {
  test("a dispatch that recalled nothing", () => {
    expect("recalled_concept_ids" in body("trace-none")).toBe(false);
  });
  test("a store no root entry began, and a delivery outside any dispatch", () => {
    expect("recalled_concept_ids" in body("trace-noroot")).toBe(false);
    expect("recalled_concept_ids" in body("trace-nocontext")).toBe(false);
  });
  test("no ids, or an empty list: the body is today's, byte for byte", () => {
    const today = JSON.stringify({ execution_id: "exec_1", reached: true, completion_shapes: ["shellResult"], reason: "ok", goal_hash: "h1" });
    expect(reachVerdictBody("exec_1", true, ["shellResult"], "ok", "h1")).toBe(today);
    expect(reachVerdictBody("exec_1", true, ["shellResult"], "ok", "h1", undefined, null, [])).toBe(today);
    expect(reachVerdictBody("exec_1", true, ["shellResult"], "ok", "h1", undefined, null, null)).toBe(today);
  });
});
