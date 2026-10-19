// AN ASYNC DISPATCH CARRIES ITS LEARNING MODE TO THE RUN IT STARTS. handleResolve's goalDispatchAsync branch
// (src/index.ts) re-enters /run-goal through a synthetic Request whose body is a fixed field list, and that list has no
// learning_mode and no ablation. handleRunGoal reads the mode from the TOP-LEVEL body.learning_mode, so an async
// dispatch sent as "observe" runs as learn: only a direct POST /run-goal can observe.
//
// Neither handler is exported and the server binds only under import.meta.main, so the real text is cut out of
// src/index.ts and transpiled, as dispatch-context-entry.test.ts does for the floor's re-entry:
//   - handleResolve from its signature through the goalDispatchAsync branch, with handleRunGoal replaced by a spy that
//     receives the synthetic Request the branch built;
//   - handleRunGoal's own ablation/learningMode parse, which is the value its record and dispatchContext entry carry.
// The run's mode is then judged by the real gate: enterDispatchContext + observeSkips, the pair index.ts's
// observeSkip() reads.
//   both forms: a top-level { type: "goalDispatchAsync", … } and an impulse-wrapper pointer (federation ingress);
//   ablation:   the ablation object reaches the run unchanged;
//   control:    a direct /run-goal body with learning_mode "observe" is in observe mode, and "learn" is not.
import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import { enterDispatchContext, type DispatchContextStore } from "../../src/dispatch-context";
import { observeSkips, resetObserveSkips } from "../../src/observe-mode";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../../src/index.ts`, "utf8") as string;
const tp = new Bun.Transpiler({ loader: "ts" });

const resolveStart = src.indexOf("async function handleResolve(req: Request): Promise<Response> {");
const branchEndMark = "    return handleRunGoal(synthetic);\n  }\n";
const branchEnd = src.indexOf(branchEndMark, resolveStart);
const resolveTs = `${src.slice(resolveStart, branchEnd + branchEndMark.length)}  return null;\n}\n`;

const parseStartMark = "  const ablation = (typeof body.ablation === \"object\" && body.ablation !== null)";
const parseStart = src.indexOf(parseStartMark, src.indexOf("async function handleRunGoal(req: Request): Promise<Response> {"));
const parseEndMark = "      : undefined;\n";
const parseEnd = src.indexOf(parseEndMark, src.indexOf("const learningMode: \"observe\" | \"learn\" | undefined =", parseStart));
const parseTs = `function runGoalModes(body: Record<string, unknown>) {\n${src.slice(parseStart, parseEnd + parseEndMark.length)}  return { ablation, learningMode };\n}\n`;

let forwarded: Request[] = [];
const handleRunGoalSpy = async (req: Request): Promise<Response> => { forwarded.push(req); return Response.json({ dispatchId: "spy" }, { status: 202 }); };
const handleResolve = new Function("handleRunGoal", `${tp.transformSync(resolveTs)}\nreturn handleResolve;`)(handleRunGoalSpy) as
  (req: Request) => Promise<Response | null>;
const runGoalModes = new Function(`${tp.transformSync(parseTs)}\nreturn runGoalModes;`)() as
  (body: Record<string, unknown>) => { ablation?: Record<string, unknown>; learningMode?: "observe" | "learn" };

const dispatchContext = new AsyncLocalStorage<DispatchContextStore>();
/** The run handleRunGoal would start from this body: its parsed modes, and whether its observe gate skips a gap write. */
const runOf = (body: Record<string, unknown>, dispatchId: string) => {
  const modes = runGoalModes(body);
  const store = enterDispatchContext(dispatchContext.getStore(), { dispatchId, learningMode: modes.learningMode });
  const observing = dispatchContext.run(store, () => { const s = dispatchContext.getStore(); return observeSkips(s?.learningMode, s?.dispatchId, "gap_write", () => {}); });
  return { ...modes, observing };
};

const GOAL = "summarise the fixture inventory sheet (async learning-mode check)";
const ABLATION = { disableReuse: true, seed: 7 };
const post = (body: unknown) => new Request("http://local/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
/** Drive the real goalDispatchAsync branch and return the body it forwarded to handleRunGoal (exactly one). */
async function forwardedBody(body: unknown): Promise<Record<string, unknown>> {
  forwarded = [];
  const res = await handleResolve(post(body));
  expect(res).not.toBeNull();
  expect(res!.status).toBe(202);
  expect(forwarded.length).toBe(1);
  expect(new URL(forwarded[0]!.url).pathname).toBe("/run-goal");
  const fwd = (await forwarded[0]!.json()) as Record<string, unknown>;
  expect(fwd.goal).toBe(GOAL);
  return fwd;
}

afterEach(() => { resetObserveSkips(); });

describe("an async dispatch carries learning_mode and ablation to the run it starts", () => {
  test("cut the real goalDispatchAsync branch and the real /run-goal mode parse", () => {
    expect(resolveStart).toBeGreaterThan(0);
    expect(branchEnd).toBeGreaterThan(resolveStart);
    expect(resolveTs).toContain('if (type === "goal_dispatch_async" || type === "goalDispatchAsync") {');
    expect(resolveTs).toContain('const synthetic = new Request("http://local/run-goal", {');
    expect(parseStart).toBeGreaterThan(0);
    expect(parseEnd).toBeGreaterThan(parseStart);
    expect(parseTs).toContain("body.learning_mode === \"observe\" || body.learning_mode === \"learn\"");
    expect(src).toContain("...(learningMode ? { learningMode } : {}) };");
    expect(src).toContain("dispatchContext.enterWith(enterDispatchContext(dispatchContext.getStore(), { dispatchId, learningMode }));");
  });

  test("[MUST-FAIL] top-level goalDispatchAsync with learning_mode observe: the run it starts is in observe mode", async () => {
    const fwd = await forwardedBody({ type: "goalDispatchAsync", goal: GOAL, learning_mode: "observe", ablation: ABLATION });
    expect(fwd.learning_mode).toBe("observe");
    expect(fwd.ablation).toEqual(ABLATION);
    const run = runOf(fwd, "d-top");
    expect(run.learningMode).toBe("observe");
    expect(run.ablation).toEqual(ABLATION);
    expect(run.observing).toBe(true);
  });

  test("[MUST-FAIL] impulse-wrapper goal_dispatch_async with learning_mode observe: the run it starts is in observe mode", async () => {
    const fwd = await forwardedBody({ impulse: { pointer: { type: "goal_dispatch_async", goal: GOAL, learning_mode: "observe", ablation: ABLATION } } });
    expect(fwd.learning_mode).toBe("observe");
    expect(fwd.ablation).toEqual(ABLATION);
    const run = runOf(fwd, "d-ptr");
    expect(run.learningMode).toBe("observe");
    expect(run.ablation).toEqual(ABLATION);
    expect(run.observing).toBe(true);
  });

  test("control: a direct /run-goal body with learning_mode observe is in observe mode, and learn is not", () => {
    const observe = runOf({ goal: GOAL, learning_mode: "observe", ablation: ABLATION }, "d-direct");
    expect(observe.learningMode).toBe("observe");
    expect(observe.ablation).toEqual(ABLATION);
    expect(observe.observing).toBe(true);
    const learn = runOf({ goal: GOAL, learning_mode: "learn" }, "d-learn");
    expect(learn.learningMode).toBe("learn");
    expect(learn.observing).toBe(false);
  });
});
