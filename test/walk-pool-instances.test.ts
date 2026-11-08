// THE WALK'S POOL HOLDS SEVERAL INSTANCES OF A SHAPE, AND A REFUSED HOP IS RE-ATTEMPTED ONLY ON NEW EVIDENCE.
//
// Replays goals through the REAL src/index.ts walk in the verdict-diff harness's hermetic child (the same pattern as
// test/command-egress-loop.test.ts: fetch stubbed, virtual clock, every outbound request recorded). The harness child
// refuses to run where /workspace or /vessels exists, so these run on a host checkout, not inside the container.
// The pure ledger rules are pinned by src/walk-instances.test.ts, which runs anywhere.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS_PATH, HARNESS_DIR, childEnv } from "./judge-split/verdict-diff/runner";

const TREE = resolve(import.meta.dir, "..");
const HERMETIC = !existsSync("/workspace") && !existsSync("/vessels");

interface Rec { url: string; method: string; route: string; body: any }
export interface Replay { requests: Rec[]; log: string; record: any }

export async function replay(sc: unknown): Promise<Replay> {
  const ws = mkdtempSync(join(tmpdir(), "pool-instances-"));
  try {
    const scPath = join(ws, "scenario.json");
    const out = join(ws, "out.json");
    writeFileSync(scPath, JSON.stringify(sc));
    const proc = Bun.spawn([process.execPath, join(HARNESS_DIR, "child.ts"), TREE, scPath, DEFAULTS_PATH, out], {
      cwd: ws, env: childEnv(ws), stdout: "pipe", stderr: "pipe",
    });
    const [code, , stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (!existsSync(out)) throw new Error(`child produced no output (exit ${code}): ${stderr.slice(-1500)}`);
    const rec = JSON.parse(readFileSync(out, "utf8")) as { fatal?: string; requests?: Rec[]; steps?: Array<{ record?: unknown }> };
    if (rec.fatal) throw new Error(`child fatal: ${rec.fatal}`);
    const logPath = out.replace(/\.json$/, ".log.json");
    const logs = existsSync(logPath) ? (JSON.parse(readFileSync(logPath, "utf8")) as { logs?: string[] }).logs ?? [] : [];
    return { requests: rec.requests ?? [], log: logs.join("\n"), record: rec.steps?.[0]?.record ?? null };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** The first walk's log: everything before its recordGoalPath line (a recovery walk may follow with a fresh ledger). */
const firstWalk = (log: string): string => {
  const ends = ["recordGoalPath PRECONDITIONS", "(walk-complete)", "ADDITIVE — continuing"].map((m) => log.indexOf(m)).filter((i) => i >= 0);
  return ends.length === 0 ? log : log.slice(0, Math.min(...ends));
};
const count = (text: string, needle: string): number => text.split(needle).length - 1;
const typeOf = (q: Rec): string | undefined => q.body?.impulse?.pointer?.type;
const sendsOf = (r: Replay, shape: string): Rec[] => r.requests.filter((q) => typeOf(q) === shape);

/** A goal whose target is `hop`, served by its own vessel; `schemas` answers resolver_schema per shape; `walkBudget`
 *  (when given) is served by a walk-budget vessel. */
export function hopScenario(id: string, o: {
  targets: string[];
  shapes: string[];
  schemas: Record<string, Array<Record<string, unknown>>>;
  routes: Array<Record<string, unknown>>;
  walkBudget?: Record<string, unknown>;
  argAnswers?: Array<Record<string, unknown>>;
}) {
  return {
    id,
    description: "walk pool-instances test (not part of the verdict-diff corpus)",
    fleet: { vessels: [
      { id: "hop-vessel", endpoint: "http://hop-vessel.test.invalid", resolve_endpoint: "/v2/impulses/resolve", shapes: o.shapes },
      ...(o.walkBudget ? [{ id: "budget-vessel", endpoint: "http://budget.test.invalid", resolve_endpoint: "/v2/impulses/resolve", shapes: ["walkBudget"] }] : []),
    ] },
    routes: [
      { id: "llm:target-inference", method: "POST", caller: "goal-host:goal_target_inference",
        respond: { llm: JSON.stringify({ target_shapes: o.targets, confidence: 0.9, alternatives: [] }) } },
      ...Object.entries(o.schemas).map(([shape, fields]) => ({ id: `schema:${shape}`, method: "POST", type: "resolver_schema", body: [`"shape":"${shape}"`],
        respond: { json: { success: true, shape: "resolver_schema", body: { shape, known: true, fields } } } })),
      { id: "llm:arg-extraction", method: "POST", caller: "goal-host:pointer_arg_extraction",
        ...(o.argAnswers ? { sequence: o.argAnswers.map((a) => ({ llm: JSON.stringify(a) })) } : { respond: { llm: "{}" } }) },
      ...(o.walkBudget ? [{ id: "walkBudget", method: "POST", type: "walkBudget", respond: { json: { resolved: true, shape: "walkBudget", body: o.walkBudget } } }] : []),
      ...o.routes,
      { id: "judge", method: "POST", caller: "goal-host:reach_verification", respond: { llm: "{\"reached\": true, \"reason\": \"hop answered\", \"completion_shapes\": []}" } },
      { id: "floor:answer", method: "POST", caller: "goal-host:floor_tool_loop", respond: { json: { success: true, shape: "llmTextCompletion", body: { text: "UNKNOWN" } } } },
    ],
    steps: [{ op: "runGoal", body: { goal: "Report what hopX answers." } }],
  };
}

const EVIDENCE = "EVIDENCE-RECORD-42";
export const h1 = (walkBudget?: Record<string, unknown>) => hopScenario(walkBudget ? "h1-evidence-arrives" : "h1-control-no-cap", {
  targets: ["hopX"],
  shapes: ["hopX", "evidenceRecord"],
  schemas: { hopX: [{ name: "evidence", required: true, type: "string", from_shape: "evidenceRecord" }], evidenceRecord: [] },
  routes: [
    { id: "hop:evidenceRecord", method: "POST", type: "evidenceRecord", respond: { json: { success: true, shape: "evidenceRecord", body: EVIDENCE } } },
    { id: "hop:hopX", method: "POST", type: "hopX", respond: { json: { success: true, shape: "hopX", body: { answer: "hopX ran on the evidence" } } } },
  ],
  ...(walkBudget ? { walkBudget } : {}),
});

describe.skipIf(!HERMETIC)("a refused hop succeeds after its evidence arrives", () => {
  test("H1: hopX is NOT invoked without its evidence, evidenceRecord is demanded and resolved, then hopX runs bound to it", async () => {
    const r = await replay(h1({ max_attempts_per_producer: 2 }));
    expect(r.log).toContain("NOT invoked — unbindable required input: evidence (hopX)");
    expect(r.log).toContain("unmet input hopX.evidence — demanding evidenceRecord");
    const ev = sendsOf(r, "evidenceRecord");
    const hop = sendsOf(r, "hopX");
    expect(ev.length).toBe(1);
    expect(hop.length).toBe(1);
    expect(JSON.stringify(hop[0]!.body.impulse.pointer.evidence)).toContain(EVIDENCE);
    expect(r.requests.indexOf(ev[0]!)).toBeLessThan(r.requests.indexOf(hop[0]!));
    expect(r.log).toContain("RE-ATTEMPT satisfier:hopX");
    expect(firstWalk(r.log)).toMatch(/reach-input: .*shapes=[^ ]*hopX/);
  }, 120_000);

  test("H1 control: with walkBudget absent the hop is not re-attempted in that walk; the absence and the unmet input are recorded", async () => {
    const r = await replay(h1());
    const walk1 = firstWalk(r.log);
    expect(walk1).toContain("walkBudget.max_attempts_per_producer absent: satisfier:hopX would be re-eligible");
    expect(walk1).toContain("unmet input hopX.evidence — demanding evidenceRecord");
    expect(walk1).not.toContain("RE-ATTEMPT satisfier:hopX");
    expect(walk1).toContain("ROUTE-AROUND stall missing=[hopX]");
    const ra = (r.record?.routeArounds ?? []) as Array<{ unmet_inputs?: Array<{ hop: string; field: string; shape: string | null }>; reattempt_refused?: string[] }>;
    expect(ra[0]?.unmet_inputs?.[0]).toMatchObject({ hop: "hopX", field: "evidence", shape: "evidenceRecord" });
    expect(String(ra[0]?.reattempt_refused?.[0])).toContain("satisfier:hopX: cap absent");
  }, 120_000);
});

const failing = (shape: string) => ({ id: `hop:${shape}`, method: "POST", type: shape, respond: { json: { success: false, error: `${shape}: the input is not the one this hop needs` } } });
const producing = (shape: string) => ({ id: `hop:${shape}`, method: "POST", type: shape, respond: { json: { success: true, shape, body: `${shape} record` } } });

export const h3 = () => hopScenario("h3-identical", {
      targets: ["hopV", "ev1"], shapes: ["hopV", "ev1"],
      schemas: { hopV: [{ name: "q", required: true, type: "string" }], ev1: [] },
      routes: [producing("ev1"), failing("hopV")],
      argAnswers: Array.from({ length: 12 }, () => ({ q: "cmd1" })),
      walkBudget: { max_attempts_per_producer: 2 },
    });
export const h4 = (cap = 2) => hopScenario(`h4-cap-${cap}`, {
      targets: ["hopW", "ev1", "ev2", "ev3"], shapes: ["hopW", "ev1", "ev2", "ev3"],
      schemas: { hopW: [{ name: "q", required: true, type: "string" }], ev1: [], ev2: [], ev3: [] },
      routes: [producing("ev1"), producing("ev2"), producing("ev3"), failing("hopW")],
      argAnswers: Array.from({ length: 24 }, (_, i) => ({ q: `variant-${i}` })),
      walkBudget: { max_attempts_per_producer: cap },
    });
export const h5 = () => hopScenario("h5-no-new-impulse", {
      targets: ["hopZ"], shapes: ["hopZ"],
      schemas: { hopZ: [] },
      routes: [failing("hopZ")],
      walkBudget: { max_attempts_per_producer: 5 },
    });

describe.skipIf(!HERMETIC)("re-attempts are bounded by new evidence and the cap", () => {
  test("H3: an identical command is not re-run — the re-attempt's identical send is refused before egress", async () => {
    const r = await replay(h3());
    const walk1 = firstWalk(r.log);
    expect(walk1).toContain("RE-ATTEMPT satisfier:hopV");
    expect(walk1).toContain("walk rawResolve hopV (satisfier-direct): NOT sent — identical instance already failed in this walk");
    // every hopV send carried cmd1 and was made before ev1 arrived (the re-attempt sent nothing)
    const hop = sendsOf(r, "hopV");
    const ev = sendsOf(r, "ev1");
    expect(ev.length).toBeGreaterThan(0);
    expect(hop.length).toBeGreaterThan(0);
    for (const q of hop) expect(q.body.impulse.pointer.q).toBe("cmd1");
    // the re-attempt in the first walk sent nothing: no hopV answer is logged after it
    const afterRe = walk1.slice(walk1.indexOf("RE-ATTEMPT satisfier:hopV"));
    expect(afterRe).not.toContain("walk rawResolve hopV: success=false");
  }, 120_000);

  test("H4: attempts stop at max_attempts_per_producer although new evidence keeps arriving", async () => {
    // cap 2: the first attempt and ONE re-attempt (after new evidence), never a third in that walk
    const two = firstWalk((await replay(h4(2))).log);
    expect(count(two, 'vessel-resolve satisfier for "hopW" returned no content')).toBe(1);
    expect(count(two, "RE-ATTEMPT satisfier:hopW")).toBe(1);
    // cap 1: new evidence arrives, the re-attempt is due, and the cap refuses it (recorded on the route-around)
    const r1 = await replay(h4(1));
    expect(firstWalk(r1.log)).not.toContain("RE-ATTEMPT satisfier:hopW");
    const ra = (r1.record?.routeArounds ?? []) as Array<{ reattempt_refused?: string[] }>;
    expect(String(ra[0]?.reattempt_refused ?? [])).toContain("satisfier:hopW: cap 1 reached");
  }, 120_000);

  test("H5: the walk terminates when no new impulse arrives — one attempt, then route-around", async () => {
    const r = await replay(h5());
    const walk1 = firstWalk(r.log);
    expect(walk1).toContain('vessel-resolve satisfier for "hopZ" returned no content');
    expect(walk1).not.toContain("RE-ATTEMPT satisfier:hopZ");
    expect(walk1).not.toContain("would be re-eligible");
    expect(walk1).toContain("ROUTE-AROUND stall missing=[hopZ]");
  }, 120_000);
});

// ── W1a-4: the world-state key, the bound demand and the no-progress guard ──
const RUN_FIELDS = { testRun: [{ name: "cmd", required: true, type: "string" }] };
const testRunSends = (r: Replay): Rec[] => sendsOf(r, "testRun");

/** A test run, a fix (an update the write door admits as the goal's product) and a hop that needs both. The hop refuses
 *  a run made before the fix and accepts one made after it. */
export const h2 = (cap = 3) => hopScenario(`h2-bound-demand-${cap}`, {
  targets: ["testRun", "hopY", "fix_update"],
  shapes: ["hopY", "testRun", "fix_update"],
  schemas: {
    hopY: [{ name: "out", required: true, type: "string", from_shape: "testRun" }, { name: "fix", required: true, type: "string", from_shape: "fix_update" }],
    ...RUN_FIELDS,
    fix_update: [{ name: "patch", required: true, type: "string" }],
  },
  routes: [
    { id: "hop:testRun", method: "POST", type: "testRun", sequence: [
      { json: { success: true, shape: "testRun", body: "RUN-1 before the fix" } },
      { json: { success: true, shape: "testRun", body: "RUN-2 after the fix" } },
    ] },
    { id: "hop:fix_update", method: "POST", type: "fix_update", respond: { json: { success: true, shape: "fix_update", body: { id: "fix-1", applied: true } } } },
    { id: "hop:hopY-after-fix", method: "POST", type: "hopY", body: ["RUN-2 after the fix"], respond: { json: { success: true, shape: "hopY", body: { answer: "hopY ran on the run after the fix" } } } },
    { id: "hop:hopY", method: "POST", type: "hopY", respond: { json: { success: false, error: "hopY: out is a run from before the fix" } } },
  ],
  argAnswers: [{ cmd: "run-tests", patch: "p1" }],
  walkBudget: { max_attempts_per_producer: cap },
});

/** The same, with no fix: the hop's refusal raises the bound demand, and the re-run of the same command finds no change. */
export const guard = (walkBudget: Record<string, unknown>) => hopScenario("h2-guard-no-write", {
  targets: ["hopQ"],
  shapes: ["hopQ", "testRun"],
  schemas: { hopQ: [{ name: "out", required: true, type: "string", from_shape: "testRun" }], ...RUN_FIELDS },
  routes: [
    { id: "hop:testRun", method: "POST", type: "testRun", respond: { json: { success: true, shape: "testRun", body: "TEST-RUN-OUTPUT" } } },
    { id: "hop:hopQ", method: "POST", type: "hopQ", respond: { json: { success: false, error: "hopQ: out is not a test run of the current tree" } } },
  ],
  argAnswers: [{ cmd: "run-tests" }],
  walkBudget,
});

describe.skipIf(!HERMETIC)("a refused hop succeeds after its evidence arrives, via the bound demand", () => {
  test("H2: the hop refuses the run made before the fix; the bound demand re-runs the test after it; the hop then runs on the new run", async () => {
    const r = await replay(h2());
    const walk1 = firstWalk(r.log);
    expect(walk1).toContain('bound demand — hopY refused with hopY.out bound to testRun; demanding a new instance of testRun with binding {"cmd":"run-tests"}');
    // the fix is an admitted write: its input is never demanded again
    expect(walk1).not.toContain("hopY.fix bound to fix_update");
    expect(walk1).toContain("pool: instance #2 of testRun from satisfier:testRun");
    const hop = sendsOf(r, "hopY").filter((q) => q.body.impulse.pointer.out !== undefined);
    expect(hop.length).toBeGreaterThanOrEqual(2);
    // the refused attempt (its sends) carried the run from before the fix; the last send carries the newest run
    expect(JSON.stringify(hop[0]!.body.impulse.pointer.out)).toContain("RUN-1 before the fix");
    expect(JSON.stringify(hop[hop.length - 1]!.body.impulse.pointer.out)).toContain("RUN-2 after the fix");
    // the re-run went through selection (the satisfier or the producer scan), after the fix
    const runs = testRunSends(r);
    const fix = sendsOf(r, "fix_update");
    expect(r.requests.indexOf(fix[0]!)).toBeLessThan(r.requests.indexOf(runs[1]!));
    expect(walk1).toMatch(/reach-input: .*shapes=[^ ]*hopY/);
  }, 120_000);
});

describe.skipIf(!HERMETIC)("the world-state key: an admitted write makes the same command a new instance", () => {
  test("the same command before and after an admitted write is two instances; twice with no write between it is a re-attempt counted against the cap", async () => {
    // before and after the fix: two testRun sends with the same command, both pooled
    const withWrite = await replay(h2());
    const w = firstWalk(withWrite.log);
    const runs = testRunSends(withWrite).slice(0, 2);
    expect(runs.map((q) => q.body.impulse.pointer.cmd)).toEqual(["run-tests", "run-tests"]);
    expect(w).toContain("pool: instance #2 of testRun from satisfier:testRun");
    expect(w).not.toContain("RE-ATTEMPT satisfier:testRun");
    // no write between: the same command again is a RE-ATTEMPT (it counts against the cap and the step budget)
    const noWrite = await replay(guard({ max_attempts_per_producer: 2 }));
    const g = firstWalk(noWrite.log);
    expect(g).toContain("RE-ATTEMPT satisfier:testRun");
    expect(g).not.toContain("pool: instance #2 of testRun");
    // and with cap 1 the same due re-run is refused by the cap (the hop's own re-attempt needs cap 2, so serve it 1)
    const capped = await replay(guard({ max_attempts_per_producer: 1 }));
    expect(firstWalk(capped.log)).not.toContain("RE-ATTEMPT satisfier:testRun");
  }, 120_000);
});

describe.skipIf(!HERMETIC)("a successful re-attempt that adds an identical instance makes no progress", () => {
  test("H2 guard: the deduped re-run is not a step and uses up max_no_progress_steps", async () => {
    const r = await replay(guard({ max_attempts_per_producer: 3, max_no_progress_steps: 1 }));
    const walk1 = firstWalk(r.log);
    expect(walk1).toContain("bound demand — hopQ refused with hopQ.out bound to testRun");
    expect(walk1).toContain("re-attempt of satisfier:testRun produced an identical instance already in the pool — no progress");
    expect(walk1).toContain("no_progress_limit_reached (1 consecutive steps without progress, limit 1) (failed re-attempts) — stopping");
    expect(walk1).not.toContain("pool: instance #2 of testRun");
    // the deduped re-run sent the same command again
    expect(testRunSends(r).map((q) => q.body.impulse.pointer.cmd)).toEqual(["run-tests", "run-tests"]);
  }, 120_000);
});
