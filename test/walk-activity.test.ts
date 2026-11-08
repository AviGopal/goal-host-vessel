// THE WALK ACTIVITY (src/walk-activity.ts): the walk is an activity execution of `goal-host-vessel:walk`, run by the
// ias engine like any activity. These tests drive the real engine with the real record and resolver; the walk body is
// a stand-in that runs one nested step the way the walk does (host.runTemplate with parentExecutionId = lastExecId).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActivityExecutor, ExecutionRuntime, InMemoryTemplateProvider, type ActivityTemplate, type ExecutionTrace, type Impulse } from "@avigopal/ias-executor-ts";
import { WALK_ACTIVITY_ID, WALK_TRACE_SHAPE, walkActivityTemplate, walkActivityResolver, dispatchWalkCall, goalImpulse, type WalkIdentity } from "../src/walk-activity";

const stepTemplate: ActivityTemplate = { id: "step-a", name: "step-a", tasks: [{ id: "t", description: "t", resolver: "step-a-resolver" }] };

function rig(body?: (goal: string, opts: { tag: string }, walk: WalkIdentity, ex: ActivityExecutor) => Promise<{ result: string; outputs: Impulse[] }>) {
  const runtime = new ExecutionRuntime();
  const catalogue = new InMemoryTemplateProvider();
  runtime.registerTemplateProvider(catalogue);
  const traces: ExecutionTrace[] = [];
  (runtime as unknown as { traceSink: { record: (t: ExecutionTrace) => void } }).traceSink.record = (t) => { traces.push(t); };
  const ex = new ActivityExecutor(runtime);
  runtime.resolvers.register({ id: "step-a-resolver", async resolve(ctx) { return [{ id: ctx.random.id("o"), pointer: { type: "x" }, metadata: { shape: "stepOut" }, loaded: true, content: "s" }]; } });
  const seen: Array<{ goal: string; opts: { tag: string }; walk: WalkIdentity }> = [];
  const defaultBody = async (goal: string, opts: { tag: string }, walk: WalkIdentity) => {
    seen.push({ goal, opts, walk });
    // the walk's first step: parent = the walk's own execution id; chain = caller chain + walk id
    const step = await ex.execute(stepTemplate, { parentExecutionId: walk.executionId, compositionChain: [...walk.compositionChain, walk.executionId] });
    const out: Impulse = { id: `trace-${walk.executionId}`, pointer: { type: WALK_TRACE_SHAPE }, metadata: { shape: WALK_TRACE_SHAPE }, loaded: true, content: { steps: [step.id] } };
    const produced: Impulse = { id: `produced-${walk.executionId}`, pointer: { type: "undeclaredShape" }, metadata: { shape: "undeclaredShape" }, loaded: true, content: "kept" };
    return { result: `walked:${goal}`, outputs: [out, produced] };
  };
  catalogue.register(walkActivityTemplate());
  runtime.resolvers.register(walkActivityResolver<{ tag: string }, string>((g, o, w) => (body ?? defaultBody)(g, o, w, ex), (v) => ({ tag: `from-variables:${String(v["tag"] ?? "")}` })));
  const dispatch = (goal: string, tag: string, parent?: { parentExecutionId?: string; compositionChain?: string[] }) =>
    dispatchWalkCall<{ tag: string }, string>(goal, { tag }, () => ex.execute(walkActivityTemplate(), { variables: { goal }, impulses: [goalImpulse(goal, `goal-${tag}`)], ...(parent ?? {}) }));
  return { runtime, catalogue, ex, traces, seen, dispatch };
}

describe("the walk activity record (one template id, one resolver id)", () => {
  test("the record: id, signature IN goal OUT executionTrace, one task whose resolver is the walk itself, no task-level output shapes (K7 relabel)", () => {
    const t = walkActivityTemplate();
    expect(t.id).toBe("goal-host-vessel:walk");
    expect(t.input_shapes).toEqual(["goal"]);
    expect(t.output_shapes).toEqual(["executionTrace"]);
    expect(t.tasks.length).toBe(1);
    expect(t.tasks[0]!.resolver).toBe(WALK_ACTIVITY_ID);
    expect(t.tasks[0]!.outputShapes).toBeUndefined();
    expect((t.metadata as { signature: { in_from_discovery: string[] } }).signature.in_from_discovery).toEqual(["activities", "shapes", "resolvers"]);
  });
  test("registration is idempotent: registering twice leaves one record under the id", async () => {
    const r = rig();
    r.catalogue.register(walkActivityTemplate());
    expect((await r.catalogue.getTemplate(WALK_ACTIVITY_ID))?.id).toBe(WALK_ACTIVITY_ID);
  });
  test("src/index.ts registers exactly one template and one resolver with the walk id, and no other walk-named record", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(src.match(/host\.catalogue\.register\(walkActivityTemplate\(\)\)/g)?.length).toBe(1);
    expect(src.match(/host\.runtime\.resolvers\.register\(walkActivityResolver</g)?.length).toBe(1);
    expect(src.match(/goal-host-vessel:walk/g)?.length ?? 0).toBe(0); // the id lives in walk-activity.ts only
  });
});

describe("T-W2-2 (unit form): a walk dispatch is an engine execution of goal-host-vessel:walk", () => {
  test("its own engine-minted id, templateId goal-host-vessel:walk, and its first step's parentExecutionId is that id", async () => {
    const r = rig();
    const { result, walkExecutionId } = await r.dispatch("count the files", "a", { parentExecutionId: "caller-exec", compositionChain: ["caller-exec"] });
    expect(result).toBe("walked:count the files");
    const walkTrace = r.traces.find((t) => t.templateId === WALK_ACTIVITY_ID)!;
    expect(walkTrace.id).toBe(walkExecutionId);
    expect(walkTrace.parentExecutionId).toBe("caller-exec");
    const step = r.traces.find((t) => t.templateId === "step-a")!;
    expect(step.parentExecutionId).toBe(walkExecutionId);
    expect(step.compositionChain).toEqual(["caller-exec", walkExecutionId]);
    expect(r.seen[0]!.opts.tag).toBe("a");
  });
  test("K7: an output impulse of a shape the record does not declare is kept by the engine with its own shape", async () => {
    const r = rig();
    const { walkExecutionId } = await r.dispatch("g", "k7");
    const walkTrace = r.traces.find((t) => t.id === walkExecutionId)!;
    expect(walkTrace.outputImpulseIds).toContain(`produced-${walkExecutionId}`);
    const kept = r.runtime.store.get(`produced-${walkExecutionId}`);
    expect(kept?.metadata.shape).toBe("undeclaredShape");
    expect(r.runtime.store.get(`trace-${walkExecutionId}`)?.metadata.shape).toBe(WALK_TRACE_SHAPE);
  });
  test("the body's own error reaches the dispatcher (the engine's failed trace does not swallow it)", async () => {
    const r = rig(async () => { throw new Error("walk body blew up"); });
    await expect(r.dispatch("g", "e")).rejects.toThrow("walk body blew up");
    expect(r.traces.find((t) => t.templateId === WALK_ACTIVITY_ID)?.status).toBe("failed");
  });
  test("a walk the engine starts with no dispatch call (selected by another activity) takes its goal from the input impulse and its options from variables", async () => {
    const r = rig();
    const tr = await r.ex.execute(walkActivityTemplate(), { variables: { tag: "v" }, impulses: [goalImpulse("from impulse", "gi")] });
    expect(tr.status).toBe("completed");
    expect(r.seen[0]!.goal).toBe("from impulse");
    expect(r.seen[0]!.opts.tag).toBe("from-variables:v");
  });
  test("a nested walk started by the engine inside a dispatched walk does not take its caller's call, and is refused (no depth cap read: no nesting) instead of recursing on the goal in its scope", async () => {
    const goals: string[] = [];
    let innerStatus = "";
    const r = rig(async (goal, _opts, walk, ex) => {
      goals.push(goal);
      if (goals.length > 3) throw new Error("recursed");
      if (goal === "outer") {
        const inner = await ex.execute(walkActivityTemplate(), { variables: { goal: "inner" }, parentExecutionId: walk.executionId, compositionChain: [...walk.compositionChain, walk.executionId] });
        innerStatus = inner.status;
      }
      return { result: `${goal}-done`, outputs: [] };
    });
    const { result } = await r.dispatch("outer", "o");
    expect(result).toBe("outer-done");
    expect(goals).toEqual(["outer"]);
    expect(innerStatus).toBe("failed");
    expect(r.traces.filter((t) => t.templateId === WALK_ACTIVITY_ID && t.status === "failed").length).toBe(1);
  });
});
