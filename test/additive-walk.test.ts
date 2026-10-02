// V8 — walks are additive (the user's ruling; output-shapes step 2 / agentic-floor D P6). Must-fail on
// the parent layer: FEEDBACK-RETRY, the satisfier retry and the re-frame each start a fresh walk from
// an EMPTY pool (5bef2e86: 21/459 retries lost a shape the earlier attempt had produced).
import { describe, expect, test } from "bun:test";
import * as walkPool from "../src/walk-pool";

type Carried = { stepId: string; executionId: string; inputShapes: string[]; impulses: Array<{ id: string; metadata?: Record<string, unknown> }>; consumedLater: string[] };
const carryForward = (walkPool as Record<string, unknown>)["carryForward"] as ((pool: unknown[], rederive: ReadonlySet<string>, targets?: ReadonlySet<string>) => Carried[]) | undefined;

const imp = (id: string, shape: string, content: unknown, prov: Record<string, unknown> = {}) => ({ id, metadata: { shape, ...prov }, content });
const POOL = [
  imp("w-goal", "goal", { goal: "What is happening today?" }, { producedBy: "seed" }),
  imp("w-ws", "web_search", { results: [{ title: "Iran war live", url: "https://www.aljazeera.com/x" }] }, { producedBy: "satisfier:web_search", producerExecutionId: "walk-satisfier-1", consumedIds: [] }),
  imp("w-llm", "llm_completion", "a hollow report", { producedBy: "satisfier:llm_completion", producerExecutionId: "walk-satisfier-2", consumedIds: ["w-ws"] }),
  imp("w-pd", "problem_detection", { problems: [1] }, { producedBy: "activity:t", producerExecutionId: "exec_t", consumedIds: ["w-ws"] }),
  imp("w-stub", "code_metrics", { producedBy: "activity:t", executionId: "exec_t" }, { producedBy: "activity:t", producerExecutionId: "exec_t" }),
  imp("w-at", "activity_template", { catalogue: "…" }, { producedBy: "satisfier:activity_template", producerExecutionId: "walk-satisfier-3" }),
  imp("w-note", "memoryNote_write", { ok: true }, { producedBy: "satisfier:memoryNote_write", producerExecutionId: "walk-satisfier-4" }),
];

describe("carryForward — the prior attempt's successful intermediates", () => {
  test("must-fail on parent: the retry is seeded with the steps already taken (not an empty pool)", () => {
    expect(typeof carryForward).toBe("function");
    const c = carryForward!(POOL, new Set(["memoryNote_write"]));
    expect(c.map((s) => s.stepId)).toEqual(["satisfier:web_search", "activity:t"]);
    expect(c[0]!.impulses.map((i) => i.id)).toEqual(["w-ws"]); // same id: the same impulse, within one dispatch
    expect(c[1]!.inputShapes).toEqual(["web_search"]);           // the recorded edge travels with the step
  });
  test("what the verdict was about is re-derived: answer shapes and terminals are never carried", () => {
    const shapes = carryForward!(POOL, new Set(["memoryNote_write"])).flatMap((s) => s.impulses.map((i) => i.metadata?.shape));
    expect(shapes).not.toContain("llm_completion");
    expect(shapes).not.toContain("memoryNote_write");
  });
  test("seeds, bookkeeping shapes and provenance stubs are never carried", () => {
    const shapes = carryForward!(POOL, new Set()).flatMap((s) => s.impulses.map((i) => i.metadata?.shape));
    expect(shapes).not.toContain("goal");
    expect(shapes).not.toContain("activity_template");
    expect(shapes).not.toContain("code_metrics");
  });
});

describe("qa must-fix: never carry the answer or a failure", () => {
  test("must-fail on parent: an UNCONSUMED target (the compute answer) is re-derived, so the retry runs", () => {
    const pool = [imp("s1", "shellResult", { stdout: "42\n", exit_code: 0 }, { producedBy: "satisfier:shellResult", producerExecutionId: "e1", consumedIds: [] })];
    expect(carryForward!(pool, new Set(), new Set(["shellResult"]))).toEqual([]);
  });
  test("a target a later step CONSUMED (the news goal's web_search) is an intermediate and is carried", () => {
    expect(carryForward!(POOL, new Set(), new Set(["web_search", "llm_completion"])).map((s) => s.stepId)).toContain("satisfier:web_search");
  });
  test("must-fail on parent: failed content (exit_code≠0, success:false, error envelope) is never carried", () => {
    const pool = [
      imp("f1", "shellResult", { stdout: "", stderr: "curl: (6)", exit_code: 6 }, { producedBy: "satisfier:shellResult", producerExecutionId: "e1" }),
      imp("f2", "web_search", { success: false, results: [] }, { producedBy: "satisfier:web_search", producerExecutionId: "e2" }),
      imp("f3", "http_fetch", { error: "403 Forbidden" }, { producedBy: "satisfier:http_fetch", producerExecutionId: "e3" }),
    ];
    expect(carryForward!(pool, new Set(), new Set())).toEqual([]);
  });
  test("carried-to-carried edges never ground a composite: an edge must enter a NEW step", () => {
    const tasks = [{ inputImpulseIds: [], outputImpulseIds: ["a"] }, { inputImpulseIds: ["a"], outputImpulseIds: ["b"] }, { inputImpulseIds: [], outputImpulseIds: ["c"] }];
    expect(walkPool.hasRealEdge(tasks, 2)).toBe(false);
    expect(walkPool.hasRealEdge([...tasks.slice(0, 2), { inputImpulseIds: ["b"], outputImpulseIds: ["c"] }], 2)).toBe(true);
  });
});

describe("qa7 must-fix: the target rule is the RECEIVING walk's", () => {
  // The prior attempt targeted [web_search, llm_completion]; its shellResult was produced but never
  // consumed. The re-frame targets [shellResult]: handing it that shellResult made targetMet() true
  // at intake, so the re-frame took no new step (qa7 probe v8b).
  const prior = [
    imp("w-ws", "web_search", { results: [] , note: "r" }, { producedBy: "satisfier:web_search", producerExecutionId: "e1", consumedIds: [] }),
    imp("w-sh", "shellResult", { stdout: "17\n", exit_code: 0 }, { producedBy: "satisfier:shellResult", producerExecutionId: "e2", consumedIds: [] }),
    imp("w-llm", "llm_completion", "x", { producedBy: "satisfier:llm_completion", producerExecutionId: "e3", consumedIds: ["w-ws"] }),
  ];
  test("must-fail on parent: a shape that is a target of the RE-FRAME and was not consumed before is re-derived there", () => {
    const carryForTarget = (walkPool as Record<string, unknown>)["carryForTarget"] as ((s: Carried[], t: ReadonlySet<string>) => Carried[]) | undefined;
    expect(typeof carryForTarget).toBe("function");
    const carry = carryForward!(prior, new Set());            // what the walk hands on: no target rule yet
    expect(carry.flatMap((c) => c.impulses.map((i) => i.metadata?.shape))).toContain("shellResult");
    const atIntake = carryForTarget!(carry, new Set(["shellResult"]));
    expect(atIntake.flatMap((c) => c.impulses.map((i) => i.metadata?.shape))).not.toContain("shellResult");
    // …while a shape the prior attempt consumed (web_search → writer) still carries for a target that names it
    expect(carryForTarget!(carry, new Set(["web_search"])).map((c) => c.stepId)).toContain("satisfier:web_search");
  });
});

describe("the retry seams continue from the pool (source)", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
  test("the walk takes carried steps into pool, chain and ledger before its loop, and they are not counted as attempts", () => {
    const a = src.indexOf("for (const c of carryForTarget(opts.carryFrom ?? [], target))");
    const loop = src.indexOf("while (chain.length < MAX_STEPS && !targetMet())");
    expect(a).toBeGreaterThan(0);
    expect(loop).toBeGreaterThan(a);
    const block = src.slice(a, loop);
    for (const s of ["chain.push(c.stepId)", "chainExecIds.push(c.executionId)", "recordStepEdge(_carriedIn, outShapes)", 'status: "carried"']) expect(block).toContain(s);
    // the carried step's prior consumption is its recorded edge, never fed to consumedInChain
    expect(block).toContain("ledgerStep(undefined, outShapes);");
    expect(src).toContain("attempts: chain.length - carriedSteps,");
    expect(src).toContain("carry: carryForward(poolImpulses, terminalShapes),");
    expect(src).toContain("for (const c of carryForTarget(opts.carryFrom ?? [], target)) {");
    expect(src).toContain("hasRealEdge(composite.tasks, carriedSteps)");
    // seeds are what the dispatch was HANDED; carried shapes were produced in it, so the seed set is
    // captured before the carry loop on purpose.
    expect(src.indexOf("const seedShapes = new Set<string>(producedShapes);")).toBeLessThan(src.indexOf("for (const c of carryForTarget(opts.carryFrom ?? [], target))"));
  });
  test("FEEDBACK-RETRY, the satisfier retry and the re-frame each pass the prior walk's carry", () => {
    const fb = src.indexOf("const fbWalk = await runGoalAsPoolWalk(goal, {");
    expect(src.slice(fb, fb + 1600)).toContain("carryFrom: walk.carry,");
    const sr = src.indexOf("const retryWalk = await runGoalAsPoolWalk(goal, {");
    expect(src.slice(sr, sr + 1600)).toMatch(/carryFrom: \(walk\.carry \?\? \[\]\)[\s\S]*!== suppressedShape/);
    const rf = src.indexOf("const altWalkResult = await runGoalAsPoolWalk(goal, {");
    expect(src.slice(rf, rf + 800)).toContain("carryFrom: walk.carry,");
  });
});
