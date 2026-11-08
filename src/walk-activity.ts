// THE WALK ACTIVITY: the one hand-written activity (qa ruling 3; W2 plan section (c), Q-1/Q-2 M1).
//
// The walk runs as an ACTIVITY EXECUTION, through the same mechanism that runs any activity
// (host.runTemplate -> executor.execute). The engine then mints the walk's own execution id, stamps
// templateId `goal-host-vessel:walk`, binds the goal as an input impulse, carries the caller's
// parentExecutionId / compositionChain, and records one trace for it.
//
// ONE record, ONE resolver id, both `goal-host-vessel:walk`:
// - the template is a code literal registered into the in-process catalogue at boot (idempotent: the
//   catalogue is a Map keyed by id). There is no file and no store row. Inverse: the process without the
//   entry; the catalogue has no delete.
// - the single task's resolver IS the walk body (Q-2 M1).
//
// Signature: IN the goal (an impulse), plus the activities, shapes and resolvers the walk reads from
// discovery and the context shapes it reads at use time; OUT the walk's trace (an output impulse of shape
// `executionTrace`, Q-7) plus the impulses the walk produced.
//
// K7 (ias engine.ts:1211-1226, :2142-2146): the engine keeps every impulse a resolver returns, of any shape,
// but RELABELS the impulse at position i with the task's declared outputShapes[i]. The task therefore
// declares no outputShapes: each output keeps its own shape. The signature lives on the template.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ActivityTemplate, Impulse, Resolver, ResolverContext } from "@avigopal/ias-executor-ts";

export const WALK_ACTIVITY_ID = "goal-host-vessel:walk";
/** Q-7: no trace shape is registered (registry_query shapes "trace": 0 matches), so the walk's trace shape is this. */
export const WALK_TRACE_SHAPE = "executionTrace";

/** The one walk activity record. Built in code, registered at boot. */
export function walkActivityTemplate(): ActivityTemplate {
  return {
    id: WALK_ACTIVITY_ID,
    name: "walk",
    description: "Walk the shape graph from the goal: pick activities and resolvers found through discovery, run them as nested steps, judge whether the goal was reached.",
    input_shapes: ["goal"],
    output_shapes: [WALK_TRACE_SHAPE],
    inputShapes: ["goal"],
    outputShapes: [WALK_TRACE_SHAPE],
    metadata: {
      signature: {
        in: ["goal"],
        in_from_discovery: ["activities", "shapes", "resolvers"],
        in_context: "context shapes read at use time (concept-db and others)",
        out: [WALK_TRACE_SHAPE, "the impulses the walk produced"],
      },
    },
    tasks: [{ id: "walk", description: "the walk", resolver: WALK_ACTIVITY_ID, inputShapes: ["goal"] }],
  };
}

/** What the walk body hands back: its result (read by the dispatcher) and its output impulses (kept by the engine). */
export interface WalkRun<R> {
  result: R;
  outputs: Impulse[];
}

/** One dispatch of the walk activity. Carries the dispatch-local objects (sinks, withhold maps) that must not ride
 *  in variables, and receives the body's result. Claimed by exactly one resolver run: a walk the engine starts from a
 *  nested template (compose) does not see its caller's call. */
export interface WalkCall<O, R> {
  goal: string;
  opts: O;
  claimed: boolean;
  result?: R;
  error?: unknown;
}

const walkCalls = new AsyncLocalStorage<WalkCall<unknown, unknown>>();

/** The walk's own identity, as the engine minted it, for the body to root its steps under. */
export interface WalkIdentity {
  executionId: string;
  compositionChain: readonly string[];
}

/** The resolver `goal-host-vessel:walk`: the walk body. `body` receives the call's goal and options, or, when the
 *  engine started the walk with no call (selected by another activity), the goal from its input impulse or variables
 *  and `fromVariables(variables)` as its options. */
export function walkActivityResolver<O, R>(
  body: (goal: string, opts: O, identity: WalkIdentity) => Promise<WalkRun<R>>,
  fromVariables: (variables: Record<string, unknown>) => O,
  /** Runs after the body on every exit path, the throw path included. */
  release?: (opts: O) => void,
): Resolver {
  return {
    id: WALK_ACTIVITY_ID,
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const store = walkCalls.getStore() as WalkCall<O, R> | undefined;
      const call = store && !store.claimed ? store : undefined;
      if (call) call.claimed = true;
      const identity: WalkIdentity = { executionId: context.executionId, compositionChain: [...(context.compositionChain ?? [])] };
      // NO NESTING until the depth cap is read (Q-9: absent = no nested walk, fail closed). A walk the engine starts
      // inside another execution binds the goal visible in its scope, which can be its caller's own goal: run, it
      // recurses without bound.
      if (!call && identity.compositionChain.length > 0) {
        throw new Error(`${WALK_ACTIVITY_ID}: refused: a walk started inside execution ${identity.compositionChain[identity.compositionChain.length - 1]} is a nested walk, and nesting is off (no depth cap read)`);
      }
      const goal = call?.goal ?? goalOf(context);
      if (!goal) throw new Error(`${WALK_ACTIVITY_ID}: no goal bound (no goal input impulse and no goal variable)`);
      const opts = call ? call.opts : fromVariables(context.variables);
      try {
        const run = await body(goal, opts, identity);
        if (call) call.result = run.result;
        return run.outputs;
      } catch (e) {
        if (call) call.error = e;
        throw e;
      } finally {
        release?.(opts);
      }
    },
  };
}

function goalOf(context: ResolverContext): string | null {
  for (const imp of context.inputImpulses) {
    if (imp.metadata?.shape !== "goal") continue;
    const c = imp.content as unknown;
    if (typeof c === "string" && c.length > 0) return c;
    const t = (imp.pointer as Record<string, unknown>)["goal"];
    if (typeof t === "string" && t.length > 0) return t;
  }
  const v = context.variables["goal"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** What the walk returned, as the trace record carries it. */
export interface WalkVerdict {
  status: string;
  reached: boolean;
  goalReachReason?: string;
  selectedTemplateId?: string;
  completionShapes: string[] | null;
  attempts: number;
  /** The walk's route-around record (route-around.ts buildRouteAround), when the walk built one. */
  routeAround?: unknown;
}

/** THE WALK'S OUTPUTS (R2): the trace record (shape executionTrace) first, then every impulse the walk's pool holds that
 *  is not a seed (the goal and the dispatch's variables enter the pool as `producedBy: "seed"`). Copies: the pool is not
 *  touched. The engine keeps each with its own shape (the task declares no output shapes, K7). The trace record is never
 *  degraded, so the engine's all-degraded check cannot refuse the walk's outputs. */
/** One executor send of the walk (a resolve that reached, or was refused before, egress), as its trace carries it. */
export interface WalkSend { producer: string; command: string | null; exit_status: number | null; stderr_excerpt: string | null; ok: boolean; refused_before_egress?: true }

/** The trace's record of one send: the command it ran (command / cmd / script / sql), the exit status and a stderr excerpt
 *  read from the result (or the refusal reason when there was no result), each bounded to 512 chars and passed through
 *  `scrub` (the caller's credential redaction). */
export function walkSendOf(producer: string, pointer: Record<string, unknown> | undefined, result: unknown, reachedEgress: boolean, ok: boolean, reason: string | null, scrub: (text: string) => string): WalkSend {
  const bound = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : scrub(String(v)).slice(0, 512));
  const cmd = pointer ? (pointer["command"] ?? pointer["cmd"] ?? pointer["script"] ?? pointer["sql"]) : undefined;
  let o: Record<string, unknown> | null = null;
  if (result && typeof result === "object") o = result as Record<string, unknown>;
  else if (typeof result === "string") { try { const j = JSON.parse(result); if (j && typeof j === "object") o = j as Record<string, unknown>; } catch { /* plain text */ } }
  // a resolver envelope ({ success, body | content }) carries the run under body or content
  for (const k of ["body", "content"]) { const inner = o?.[k]; if (inner && typeof inner === "object" && !Array.isArray(inner) && !("stderr" in (o as object))) { o = inner as Record<string, unknown>; break; } }
  const exitRaw = o ? (o["exit_code"] ?? o["exitCode"] ?? o["exit"]) : undefined;
  const exit = typeof exitRaw === "number" ? exitRaw : typeof exitRaw === "string" && exitRaw.trim() !== "" && Number.isFinite(Number(exitRaw)) ? Number(exitRaw) : null;
  const stderr = o && "stderr" in o ? o["stderr"] : result == null ? reason : null;
  return { producer, command: bound(cmd), exit_status: exit, stderr_excerpt: bound(stderr), ok, ...(reachedEgress ? {} : { refused_before_egress: true as const }) };
}

export function walkOutputs(walk: WalkIdentity, verdict: WalkVerdict, pool: readonly Impulse[], sends: readonly WalkSend[] = []): Impulse[] {
  const produced = pool.filter((i) => (i.metadata as Record<string, unknown> | undefined)?.["producedBy"] !== "seed");
  const trace: Impulse = {
    id: `${walk.executionId}-trace`,
    pointer: { type: WALK_TRACE_SHAPE, execution_id: walk.executionId },
    metadata: { shape: WALK_TRACE_SHAPE, summary: `walk ${walk.executionId}: ${verdict.reached ? "reached" : "not reached"}`, producedBy: WALK_ACTIVITY_ID },
    loaded: true,
    content: {
      execution_id: walk.executionId,
      composition_chain: [...walk.compositionChain],
      status: verdict.status,
      reached: verdict.reached,
      goal_reach_reason: verdict.goalReachReason ?? null,
      selected_template_id: verdict.selectedTemplateId ?? null,
      completion_shapes: verdict.completionShapes,
      attempts: verdict.attempts,
      // the executor sends behind those steps, including runs that never became a step (failed or refused)
      sends: sends.map((x) => ({ ...x })),
      outputs: produced.map((i) => ({ id: i.id, shape: (i.metadata as Record<string, unknown> | undefined)?.["shape"] ?? null })),
      // a snapshot: the dispatcher later notes the retry route it took on the live record (noteRouteTaken)
      route_around: verdict.routeAround === undefined ? null : structuredClone(verdict.routeAround),
    },
  };
  return [trace, ...produced.map((i) => ({ ...i, metadata: { ...i.metadata } }))];
}

/** CONFIRM ON BODY (agf_60oyt7cvc7pt): a 2xx from the activityExecutionTrace_write hop counts as delivered only when the
 *  store's own answer says it stored this execution id. The producer (activity-api) answers the resolve as
 *  { success, content: "<the execution-traces POST / body as JSON>" }; that body is { success, execution_id, stored: true }
 *  for an insert, but { stored: false, duplicate: true } for an id it already holds and { stored: "system_traces" } for a
 *  system-track trace (neither readable by id as this walk's trace). Anything else is accepted but unconfirmed. */
export function deliveryConfirmed(bodyText: string, executionId: string): boolean {
  const parse = (t: unknown): Record<string, unknown> | null => {
    if (t && typeof t === "object") return t as Record<string, unknown>;
    if (typeof t !== "string") return null;
    try { const j = JSON.parse(t); return j && typeof j === "object" ? (j as Record<string, unknown>) : null; } catch { return null; }
  };
  const outer = parse(bodyText);
  const inner = parse(outer?.["content"] ?? outer?.["body"]) ?? outer;
  return !!inner && inner["stored"] === true && inner["execution_id"] === executionId;
}

/** The goal as the walk's input impulse. */
export function goalImpulse(goal: string, id: string): Impulse {
  return { id, pointer: { type: "goal", goal }, metadata: { shape: "goal" }, loaded: true, content: goal };
}

/** Dispatch the walk activity once: run `exec` (the caller's host.runTemplate of the walk template) inside a call
 *  carrying `opts`, and return the body's result with the walk's execution id. The engine returns a failed trace when
 *  the body throws; the body's own error is rethrown so the caller sees what it saw before the walk was an activity. */
export async function dispatchWalkCall<O, R>(
  goal: string,
  opts: O,
  exec: () => Promise<{ id: string; status?: string; error?: string }>,
): Promise<{ result: R; walkExecutionId: string }> {
  const call: WalkCall<O, R> = { goal, opts, claimed: false };
  const trace = await walkCalls.run(call as WalkCall<unknown, unknown>, exec);
  if (call.error !== undefined) throw call.error;
  if (call.result === undefined) throw new Error(`${WALK_ACTIVITY_ID}: execution ${trace.id} produced no walk result (${trace.status ?? "?"}${trace.error ? `: ${trace.error}` : ""})`);
  return { result: call.result, walkExecutionId: trace.id };
}
