// A LANDING IS NOT A REACH (the landed latch in runGoalWithRecovery).
//
// The latch fires when a feature_compose commit for the dispatch's gap landed on origin/dev during the dispatch, and the
// walk is about to return unreached. It returned reached:true with a `deterministic:edit-intent-landed` reason and wrote
// a deterministic oracle label whenever the post-state probe (verifyEditPostState) did not refute the edit, so a probe
// that could not decide (null: the goal names no add/replace symbol, or the file is unreadable) credited on the landing
// alone. A landing proves a commit exists, not that the goal's condition holds. Rule: the latch credits only when the
// probe ran and confirmed the edit (true); undecided is an oracle abstain, with the landing kept in the reason and the
// walk log; refuted keeps the walk's own unreached verdict.
//
// Test seam: index.ts boots a server on import, so runGoalWithRecovery is cut out of src/index.ts (signature to its
// closing brace) and transpiled, as dispatch-context-entry.test.ts does, with its collaborators injected: the inner walk
// returns a fixed unreached result, git reports a landing, and the probe answers null / false / true.
// oracleAbstainVerdict is cut from the source too, so the abstain record is the real one.
import { describe, expect, test } from "bun:test";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const tp = new Bun.Transpiler({ loader: "ts" });
const cut = (sig: string): string => {
  const i = src.indexOf(sig);
  expect(i).toBeGreaterThan(0);
  return src.slice(i, src.indexOf("\n}\n", i) + 2);
};
const latchTs = cut("async function runGoalWithRecovery(");
const abstainTs = cut("function oracleAbstainVerdict(");

const SHA = "a1".repeat(20);
const GAP = "route-edit-latchtest";
const GOAL = "in repos/fixture-vessel/src/quiesce.ts make the drain wait for in-flight work";
const WALK = { result: null, status: "completed", reached: false, goalReachReason: "hollow: the walk produced no fileEditResult", attempts: 2, selectedTemplateId: "tpl-walk", completionShapes: [] };

type Run = { r: Record<string, unknown>; labels: unknown[][]; sink: string[]; decisions: unknown[][] };
async function runLatch(postOk: boolean | null): Promise<Run> {
  const labels: unknown[][] = [];
  const decisions: unknown[][] = [];
  const sink: string[] = [];
  const sent = new WeakMap<object, number>();
  const opts = { maxAttempts: 2, variables: { gap_id: GAP }, surface: "test", stepSink: sink, learningMode: "learn" };
  sent.set(opts, Date.now());
  const fn = new Function(
    "runGoalWithRecoveryInner", "_dispatchSentCompose", "composeGapIdOf", "landedCommitForGoal", "verifyEditPostState",
    "recordDeterministicLabel", "noteOracleDecision",
    `${tp.transformSync(abstainTs)}\n${tp.transformSync(latchTs)}\nreturn runGoalWithRecovery;`,
  )(
    async () => ({ ...WALK }),
    sent,
    () => GAP,
    async (vessel: string, gapId: string) => (vessel === "fixture-vessel" && gapId === GAP ? SHA : null),
    async () => postOk,
    (...a: unknown[]) => { labels.push(a); },
    async (...a: unknown[]) => { decisions.push(a); },
  ) as (goal: string, opts: unknown) => Promise<Record<string, unknown>>;
  const r = await fn(GOAL, opts);
  return { r, labels, sink, decisions };
}

describe("the landed latch credits only a decided post-state", () => {
  test("cut the real latch", () => {
    expect(latchTs).toContain("let sha = await landedCommitForGoal(");
    expect(latchTs).toContain("const postOk = await verifyEditPostState(goal, fm[0], sha);");
    expect(latchTs).toContain("recordDeterministicLabel(goal, `feature_compose:${sha}`");
  });

  test("[MUST-FAIL] a landing with an undecided post-state (null) is not reached, writes no deterministic label and no deterministic: reason", async () => {
    const { r, labels, sink, decisions } = await runLatch(null);
    expect(r.reached).not.toBe(true);
    expect(labels).toEqual([]);
    expect(String(r.goalReachReason ?? "")).not.toMatch(/^deterministic:/);
    expect(r.executionId).not.toBe(`feature_compose:${SHA}`);
    // ungraded through the existing abstain channel: no α, no β
    expect((r.abstain as { kind?: string } | undefined)?.kind).toBe("oracle-abstain");
    expect(decisions.map((d) => d[1])).toEqual(["abstain"]);
    // the landing stays visible as evidence
    expect(String(r.goalReachReason)).toContain(SHA);
    expect(sink.some((l) => l.includes("LANDED LATCH") && l.includes(SHA))).toBe(true);
  });

  test("a landing whose post-state refutes the edit (false) keeps the walk's own unreached verdict", async () => {
    const { r, labels } = await runLatch(false);
    expect(r.reached).toBe(false);
    expect(r.goalReachReason).toBe(WALK.goalReachReason);
    expect(r.selectedTemplateId).toBe("tpl-walk");
    expect(r.abstain).toBeUndefined();
    expect(labels).toEqual([]);
  });

  test("control: a landing whose post-state confirms the edit (true) still reaches, and the label is written once", async () => {
    const { r, labels } = await runLatch(true);
    expect(r.reached).toBe(true);
    expect(r.executionId).toBe(`feature_compose:${SHA}`);
    expect(String(r.goalReachReason)).toMatch(/^deterministic:edit-intent-landed/);
    expect(labels.length).toBe(1);
    expect(labels[0]![1]).toBe(`feature_compose:${SHA}`);
    expect((labels[0]![3] as { reached?: boolean }).reached).toBe(true);
  });
});
