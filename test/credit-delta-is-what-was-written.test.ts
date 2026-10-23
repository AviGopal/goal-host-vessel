// A REJECTED CREDIT POST CHANGES NEITHER α NOR β, AND THE HOLLOW LOG SAYS WHAT HAPPENED.
//
// creditReachedTemplate returned dBeta:1 when its α POST (/v2/activities/feedback, positive) was rejected or threw,
// although no β was ever written, so the dispatch's learning report (alphaBetaDelta) claimed a β that never happened.
// And the two HOLLOW lines printed "β-penalised" whatever penaliseHollowTemplate did: an observe dispatch logged
// "β-penalised last pick …" in the same second as "[observe] skipped beta_penalty". Now the delta is what was written,
// and the HOLLOW lines read the penalty's own delta.
//
// The two functions are module-private: test/fixtures/credit-delta-child.ts exposes them in a CHILD process against a
// loopback stub; the log wording is pinned on the source.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
const CHILD = join(import.meta.dir, "fixtures", "credit-delta-child.ts");
const MARK = "CREDIT_DELTA_RESULT ";
interface Case { fn: string; activity: string; delta: { templateId: string; dAlpha: number; dBeta: number }; posts: number }
let res: { exposed: boolean; cases: Case[]; refused: string[]; error?: string };
const caseOf = (fn: string, rejected: boolean): Case => {
  const c = res.cases.find((x) => x.fn === fn && x.activity.endsWith(rejected ? "rejected" : "written"));
  expect(c).toBeDefined();
  expect(c!.posts).toBe(1);
  return c!;
};

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "credit-delta-"));
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

describe("MUST-FAIL: a non-2xx credit POST changes neither α nor β", () => {
  test("a rejected α credit reports dAlpha 0 and dBeta 0", () => {
    expect(res.error).toBeUndefined();
    expect(res.exposed).toBe(true);
    expect(caseOf("credit", true).delta).toEqual({ templateId: "satisfier:credit-delta-rejected", dAlpha: 0, dBeta: 0 });
  });

  test("a thrown α credit reports no β either", () => {
    const i = SRC.indexOf("async function creditReachedTemplate(");
    const fn = SRC.slice(i, SRC.indexOf("\n}\n", i));
    expect(fn.includes("dBeta: 1")).toBe(false);
    expect(fn.trimEnd().endsWith("return { templateId: activityId, dAlpha: 0, dBeta: 0 };")).toBe(true);
  });

  test("both HOLLOW lines say β-penalised only when the penalty's own delta wrote β", () => {
    expect(SRC.includes("_hollowBetaApplied ? `β-penalised last pick ${lastPick}` : `β NOT applied to last pick ${lastPick}")).toBe(true);
    expect(SRC.includes('penaliseHollowTemplate(lastPick, verdict.reason ?? "goal not reached", goal).then((d) => { _hollowBetaApplied = d.dBeta > 0; return d; })')).toBe(true);
    expect(SRC.includes('penaliseHollowTemplate(selId, verdict.reason ?? "goal not reached", goal).then((d) => { _penApplied = d.dBeta > 0; return d; })')).toBe(true);
    expect(SRC.includes('${_penApplied ? "β-penalised" : "β NOT applied (observe, a credit hold, or the penalty POST was rejected)"}')).toBe(true);
    expect(SRC.includes(": `β-penalised last pick ${lastPick}`}")).toBe(false);
    expect(SRC.includes("— ${verdict.reason}; β-penalised. completion_shapes=")).toBe(false);
  });
});

describe("CONTROL: a written credit and a written penalty apply as before", () => {
  test("a 2xx α credit applies dAlpha 2, dBeta 0", () => {
    expect(caseOf("credit", false).delta).toEqual({ templateId: "satisfier:credit-delta-written", dAlpha: 2, dBeta: 0 });
  });

  test("a 2xx β penalty applies dBeta 2; a rejected one applies nothing (unchanged)", () => {
    expect(caseOf("penalise", false).delta).toEqual({ templateId: "satisfier:credit-delta-written", dAlpha: 0, dBeta: 2 });
    expect(caseOf("penalise", true).delta).toEqual({ templateId: "satisfier:credit-delta-rejected", dAlpha: 0, dBeta: 0 });
  });

  test("no fetch left the stub", () => { expect(res.refused).toEqual([]); });
});
