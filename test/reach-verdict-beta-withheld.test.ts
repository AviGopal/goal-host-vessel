// A β THE WALK WITHHELD IS NOT ADDED BACK BY THE LATE /reach PATCH.
//
// WHY. When a not-reached walk's verdict cannot fairly penalise its last pick (no oracle owns the
// goal class, or α was structurally unreachable: non-deterministic verdict, consumedInChain = 0),
// the walk logs "NOT REACHED but β WITHHELD for <pick>" and persists the satisfier trace untagged.
// The dispatch then runs a fallback step (measured: up to ~210 s) and afterwards sends the
// walk-complete POST /reach for the SAME execution with reached:false and nothing else, and
// activity-api applies β=1 to that execution's arm: the withhold was decided and then undone.
//
// THE RULE PINNED HERE:
//   - The dispatch keeps one record of executions whose arm a walk withheld β for (id -> reason),
//     filled at the withhold decision, only ever added to: no fallback or later walk clears it.
//   - Every /reach delivery for an execution in that record carries beta_withheld: true and
//     beta_withheld_reason. Any other execution, the fallback pick's own included, is sent the
//     body exactly as before, with no such field.
//
// The walk needs a live host and the fleet, so the walk -> fallback -> delivery SEQUENCE is pinned
// on the source (as in satisfier-trace-flush-order.test.ts), not driven; the bodies each call
// site sends are checked on the exported helpers, with fetch recorded.
//
// Import is dynamic for the reason given in index-pure-exports.test.ts (module bootstrap needs
// LLM_VESSEL_ENDPOINT). fetch is spied and restored, never mocked process-wide.
import { describe, expect, test, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env["LLM_VESSEL_ENDPOINT"] ||= "http://127.0.0.1:8220";
const { reachVerdictBody, deliverReachVerdict } = await import("../src/index");
const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

const WITHHELD = "walk-satisfier-3-1791378965133";
const FALLBACK = "universal-tool-fallback-af854b4a-1791379175000";
const WHY = "alpha-unreachable-non-deterministic-no-edge";
const REASON = "the output provides a numerical value but lacks contextual description";
const HASH = "a1b2c3";
// The body every delivery sent before this change, byte for byte.
const today = (id: string): string =>
  JSON.stringify({ execution_id: id, reached: false, completion_shapes: ["shellResult"], reason: REASON, goal_hash: HASH });

/** Run deliveries with fetch recorded; returns each POST /reach body as the raw string sent. */
async function sent(run: () => void): Promise<string[]> {
  const bodies: string[] = [];
  // A definitive 4xx: not retried, not spooled, no spool drain — the body is all we need.
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/execution-traces/reach")) bodies.push(String(init?.body));
    return new Response("{}", { status: 400 });
  }) as typeof fetch);
  try {
    run();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    spy.mockRestore();
  }
  return bodies;
}

describe("reachVerdictBody — a withheld β rides on the body", () => {
  test("MUST-FAIL: a withheld execution's body carries beta_withheld and its reason", () => {
    const b = JSON.parse(reachVerdictBody(WITHHELD, false, ["shellResult"], REASON, HASH, WHY));
    expect(b.beta_withheld).toBe(true);
    expect(b.beta_withheld_reason).toBe(WHY);
    expect(b.reached).toBe(false);
  });

  test("CONTROL: with no withhold the body is byte-identical to today's", () => {
    expect(reachVerdictBody(WITHHELD, false, ["shellResult"], REASON, HASH)).toBe(today(WITHHELD));
    expect(reachVerdictBody(WITHHELD, false, ["shellResult"], REASON, HASH, null)).toBe(today(WITHHELD));
    expect(reachVerdictBody(WITHHELD, false, ["shellResult"], REASON, HASH, undefined)).toBe(today(WITHHELD));
  });
});

describe("deliverReachVerdict — the record decides which executions are sent the withhold", () => {
  test("MUST-FAIL: the walk-complete delivery after a fallback carries beta_withheld for the withheld execution", async () => {
    // The walk withheld β for WITHHELD; the fallback ran its own pick (FALLBACK) and did not reach,
    // so the dispatch returned the walk's result and walk-complete delivers WITHHELD.
    const record = new Map<string, string>([[WITHHELD, WHY]]);
    const [raw] = await sent(() => deliverReachVerdict(WITHHELD, false, ["shellResult"], "walk-complete", REASON, HASH, record));
    const b = JSON.parse(String(raw));
    expect(b.execution_id).toBe(WITHHELD);
    expect(b.beta_withheld).toBe(true);
    expect(b.beta_withheld_reason).toBe(WHY);
  });

  test("MUST-FAIL: the walk-threw and early-edit deliveries for a withheld execution carry the flag", async () => {
    const record = new Map<string, string>([[WITHHELD, "no-oracle-for-goal-class"]]);
    const bodies = await sent(() => {
      deliverReachVerdict(WITHHELD, false, ["shellResult"], "walk-threw", "walk threw: fetch failed", HASH, record);
      deliverReachVerdict(WITHHELD, false, ["fileEditResult"], "early-edit-intent-unfavorable", "deterministic:early-edit-intent-not-landed", HASH, record);
    });
    expect(bodies.length).toBe(2);
    for (const raw of bodies) {
      const b = JSON.parse(raw);
      expect(b.beta_withheld).toBe(true);
      expect(b.beta_withheld_reason).toBe("no-oracle-for-goal-class");
    }
  });

  test("CONTROL: the fallback pick's own execution is not in the record and is graded normally — no beta_withheld field", async () => {
    const record = new Map<string, string>([[WITHHELD, WHY]]);
    const [raw] = await sent(() => deliverReachVerdict(FALLBACK, false, ["shellResult"], "walk-complete", REASON, HASH, record));
    expect(raw).toBe(today(FALLBACK));
    expect(Object.keys(JSON.parse(String(raw)))).not.toContain("beta_withheld");
  });

  test("CONTROL: a walk with no withhold sends bodies byte-identical to today's", async () => {
    const bodies = await sent(() => {
      deliverReachVerdict(WITHHELD, false, ["shellResult"], "walk-complete", REASON, HASH);
      deliverReachVerdict(WITHHELD, false, ["shellResult"], "walk-complete", REASON, HASH, new Map());
      deliverReachVerdict(WITHHELD, false, ["shellResult"], "walk-threw", REASON, HASH, null);
    });
    expect(bodies).toEqual([today(WITHHELD), today(WITHHELD), today(WITHHELD)]);
  });
});

// Pinned on the source: the walk needs a live host.
const fnBody = (name: string): string => {
  const start = SRC.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = SRC.indexOf("\nasync function ", start + 1);
  return SRC.slice(start, next === -1 ? undefined : next);
};

describe("the withhold record is filled at the decision, threaded to every walk, and reaches every delivery", () => {
  test("MUST-FAIL: the walk records the withheld execution at the decision, from the decision's own variables", () => {
    const decided = SRC.indexOf("walkBetaWithheld = _noOracle || _betaWithheldForSymmetry;");
    expect(decided).toBeGreaterThan(-1);
    const after = SRC.slice(decided, decided + 600);
    expect(after).toContain("if (walkBetaWithheld) opts.betaWithheld?.set(lastTrace.id, _noOracle ?");
    // An abstain withholds β too, but is never delivered (reached is null, so deliverReachVerdict
    // skips it, and the dispatch returns the abstain with no retry or fallback): nothing to record.
  });

  test("MUST-FAIL: every walk of the dispatch is handed the record", () => {
    const inner = fnBody("runGoalWithRecoveryInner");
    const calls = inner.split("await runGoalAsPoolWalk(goal, {").slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) expect(c.slice(0, c.indexOf("});"))).toContain("betaWithheld: opts.betaWithheld,");
    const handler = fnBody("handleRunGoal");
    expect(handler.includes("const betaWithheld = new Map<string, string>();")).toBe(true);
    const seek = handler.slice(handler.indexOf("const seek = await runGoalWithRecovery(goal, {"));
    expect(seek.slice(0, seek.indexOf("});")).includes("betaWithheld,")).toBe(true);
  });

  test("MUST-FAIL: every deliverReachVerdict call site passes the record", () => {
    const calls = SRC.split("\n").filter((l) => /\bdeliverReachVerdict\(/.test(l) && !/function deliverReachVerdict\(/.test(l) && !/^\s*\/\//.test(l));
    const origins = calls.map((l) => /"(walk-complete|walk-threw|early-edit-intent-unfavorable)"/.exec(l)?.[1]).sort();
    expect(origins).toEqual(["early-edit-intent-unfavorable", "walk-complete", "walk-threw"]);
    for (const l of calls) expect(l).toMatch(/, (opts\.)?betaWithheld\);\s*$/);
  });

  test("MUST-FAIL: the record survives the fallback — only ever added to, and the fallback step never touches it", () => {
    // Declared once, in the dispatch handler, as a const.
    expect(SRC.split("const betaWithheld = new Map<string, string>();").length - 1).toBe(1);
    // Never cleared, deleted from, or replaced anywhere.
    expect(/betaWithheld\??\.(clear|delete)\(/.test(SRC)).toBe(false);
    expect(/betaWithheld\s*=(?!=)/.test(SRC.replace("const betaWithheld = new Map<string, string>();", ""))).toBe(false);
    // The fallback step between the walk and the walk-complete delivery leaves it alone.
    const fb = SRC.indexOf('noteRouteTaken(walk.routeAround, "universal-tool-fallback");');
    expect(fb).toBeGreaterThan(-1);
    const end = SRC.indexOf("if (walk.attempts > 0 &&", fb);
    expect(end).toBeGreaterThan(fb);
    expect(SRC.slice(fb, end).includes("betaWithheld")).toBe(false);
    // And the walk-complete delivery that follows it reads the same record.
    expect(SRC.includes('"walk-complete", seek.goalReachReason, goalHashOf(String(goal ?? "")), betaWithheld);')).toBe(true);
  });
});
