// THE PRODUCER LOOKUP IS A SEARCH HOP THROUGH DISCOVERY (W3, agf_k27bykpj61zs). The walk asks discovery /resolve for a
// discoverByShapesQuery. Discovery's answer when no producer serves it (discovery-vessel src/index.ts, the /resolve
// handler's no-candidate branch): HTTP 404 {"error":"Not found","shape":"discoverByShapesQuery"}. The walk fails that
// lookup honestly, naming the shape, and records it among its failed producers (pickFailures -> the route-around
// record), classed by the shared transient rule. It is not a pool observation, so it re-arms no producer.
// Replays run the REAL src/index.ts in the verdict-diff harness child (fetch stubbed, every request recorded).
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS_PATH, HARNESS_DIR, childEnv } from "./judge-split/verdict-diff/runner";
import { isTransientFailure } from "../src/transient-failure";

const TREE = resolve(import.meta.dir, "..");
const HERMETIC = !existsSync("/workspace") && !existsSync("/vessels");
const SRC = readFileSync(join(TREE, "src", "index.ts"), "utf8");
const NOT_FOUND = { error: "Not found", shape: "discoverByShapesQuery" };

interface Replay { log: string; record: any; requests: Array<{ url: string; body: any }>; walkTraceOutputs: Array<{ executionId: string; executionTrace: any[] }>; walkTraceServed: Array<{ status?: number; json?: any }>; walkLog: string[]; walkLogAtSend: Array<{ seq: number; walkLog: string[] }> }
async function replay(sc: unknown): Promise<Replay> {
  const ws = mkdtempSync(join(tmpdir(), "producer-lookup-"));
  try {
    const scPath = join(ws, "scenario.json");
    const out = join(ws, "out.json");
    writeFileSync(scPath, JSON.stringify(sc));
    const proc = Bun.spawn([process.execPath, join(HARNESS_DIR, "child.ts"), TREE, scPath, DEFAULTS_PATH, out], { cwd: ws, env: childEnv(ws, { VD_WALK_TRACE_OUTPUTS: "1" }), stdout: "pipe", stderr: "pipe" });
    const [code, , stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (!existsSync(out)) throw new Error(`child produced no output (exit ${code}): ${stderr.slice(-1500)}`);
    const rec = JSON.parse(readFileSync(out, "utf8")) as { fatal?: string; requests?: Replay["requests"]; steps?: Array<{ record?: unknown; walkLog?: string[] }> };
    if (rec.fatal) throw new Error(`child fatal: ${rec.fatal}`);
    const logPath = out.replace(/\.json$/, ".log.json");
    const side = existsSync(logPath) ? (JSON.parse(readFileSync(logPath, "utf8")) as { logs?: string[]; walkTraceOutputs?: Replay["walkTraceOutputs"]; walkTraceServed?: Replay["walkTraceServed"]; walkLogAtSend?: Replay["walkLogAtSend"] }) : {};
    return { log: (side.logs ?? []).join("\n"), record: rec.steps?.[0]?.record ?? null, requests: rec.requests ?? [], walkTraceOutputs: side.walkTraceOutputs ?? [], walkTraceServed: side.walkTraceServed ?? [], walkLog: rec.steps?.[0]?.walkLog ?? [], walkLogAtSend: side.walkLogAtSend ?? [] };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** H5's shape (one hop that keeps failing, walkBudget max_attempts_per_producer 5), with discovery answering the
 *  producer lookup with `lookup`. */
const scenario = (id: string, lookup: { status: number; json: unknown }, extraRoutes: unknown[] = []) => ({
  id,
  description: "producer lookup test (not part of the verdict-diff corpus)",
  fleet: { vessels: [
    { id: "hop-vessel", endpoint: "http://hop-vessel.test.invalid", resolve_endpoint: "/v2/impulses/resolve", shapes: ["hopZ"] },
    { id: "budget-vessel", endpoint: "http://budget.test.invalid", resolve_endpoint: "/v2/impulses/resolve", shapes: ["walkBudget"] },
  ] },
  routes: [
    { id: "discovery:producer-lookup", method: "POST", type: "discoverByShapesQuery", respond: lookup },
    ...extraRoutes,
    { id: "llm:target-inference", method: "POST", caller: "goal-host:goal_target_inference", respond: { llm: JSON.stringify({ target_shapes: ["hopZ"], confidence: 0.9, alternatives: [] }) } },
    { id: "schema:hopZ", method: "POST", type: "resolver_schema", body: ['"shape":"hopZ"'], respond: { json: { success: true, shape: "resolver_schema", body: { shape: "hopZ", known: true, fields: [] } } } },
    { id: "llm:arg-extraction", method: "POST", caller: "goal-host:pointer_arg_extraction", respond: { llm: "{}" } },
    { id: "walkBudget", method: "POST", type: "walkBudget", respond: { json: { resolved: true, shape: "walkBudget", body: { max_attempts_per_producer: 5 } } } },
    { id: "hop:hopZ", method: "POST", type: "hopZ", respond: { json: { success: false, error: "hopZ: the input is not the one this hop needs" } } },
    { id: "judge", method: "POST", caller: "goal-host:reach_verification", respond: { llm: "{\"reached\": true, \"reason\": \"hop answered\", \"completion_shapes\": []}" } },
    { id: "floor:answer", method: "POST", caller: "goal-host:floor_tool_loop", respond: { json: { success: true, shape: "llmTextCompletion", body: { text: "UNKNOWN" } } } },
  ],
  steps: [{ op: "runGoal", body: { goal: "Report what hopZ answers." } }],
});
const firstWalk = (log: string): string => {
  const ends = ["recordGoalPath PRECONDITIONS", "(walk-complete)", "ADDITIVE — continuing", "walk-activity: dispatched"].map((m) => log.indexOf(m)).filter((i) => i >= 0);
  return ends.length === 0 ? log : log.slice(0, Math.min(...ends));
};
const LOOKUP_LINE = "producer lookup: no producer answered discoverByShapesQuery";
const lookupFailures = (r: Replay) => ((r.record?.routeArounds ?? []) as Array<{ failed_producers?: Array<{ producer: string; reason: string }> }>)
  .flatMap((ra) => ra.failed_producers ?? []).filter((f) => f.producer === "lookup:discoverByShapesQuery");

describe("the producer lookup's classes (the shared transient rule)", () => {
  test("discovery's no-producer answer (404 Not found) is NON-transient; a 503 is transient", () => {
    expect(isTransientFailure(`HTTP 404: ${JSON.stringify(NOT_FOUND)}`, 404)).toBe(false);
    expect(isTransientFailure("HTTP 503: forward_failed", 503)).toBe(true);
  });
  test("the walk asks discovery /resolve for discoverByShapesQuery at all four lookup sites; no lookup dials the activity-api route", () => {
    expect(SRC.match(/await lookupProducers\(\{ required_shapes: /g)?.length).toBe(4);
    expect(SRC).toContain('body: JSON.stringify({ pointer: { type: "discoverByShapesQuery", ...query } }),');
    expect(SRC.match(/\$\{PRODUCER_DISCOVERY_ENDPOINT\}\/v2\/activities\/discover-by-shapes/g)?.length).toBe(1); // fileReachabilityGap, OUT (debt)
  });
});

describe.skipIf(!HERMETIC)("a failed producer lookup is a failed producer, never new evidence", () => {
  test("404 (non_transient): named, in the route-around record, and N>=4 failed lookups re-arm nothing (0 RE-ATTEMPT)", async () => {
    const r = await replay(scenario("lookup-404", { status: 404, json: NOT_FOUND }));
    const walk1 = firstWalk(r.log);
    expect(walk1.split(LOOKUP_LINE).length - 1).toBeGreaterThanOrEqual(4);
    expect(walk1).toContain("(HTTP 404: {\"error\":\"Not found\",\"shape\":\"discoverByShapesQuery\"}) — non_transient, recorded among the walk's failed producers");
    expect(walk1).not.toContain("RE-ATTEMPT");
    expect(walk1).not.toContain("would be re-eligible");
    const f = lookupFailures(r);
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f[0]!.reason).toContain("HTTP 404 no producer (non_transient)");
    // The 4 lookups go to discovery; the only discover-by-shapes dial left is fileReachabilityGap's (OUT, debt).
    expect(r.requests.filter((q) => q.body?.pointer?.type === "discoverByShapesQuery").length).toBeGreaterThanOrEqual(4);
  }, 120_000);
  test("guard 2: the failed lookup is in the walk execution's executionTrace output (read by shape), verbatim from the route-around record", async () => {
    const r = await replay(scenario("lookup-404-trace", { status: 404, json: NOT_FOUND }));
    expect(r.walkTraceOutputs.length).toBeGreaterThanOrEqual(1);
    const first = r.walkTraceOutputs[0]!;
    expect(first.executionTrace.length).toBe(1);
    const ra = first.executionTrace[0].route_around;
    const f = (ra?.failed_producers ?? []).find((x: { producer: string }) => x.producer === "lookup:discoverByShapesQuery");
    expect(f).toBeDefined();
    expect(String(f.reason).startsWith("HTTP 404 no producer (non_transient)")).toBe(true);
    // verbatim: the record's own route-around (the dispatch record keeps the same buildRouteAround record)
    expect(ra.failed_producers).toEqual(r.record.routeArounds[0].failed_producers);
  }, 120_000);
  test("guard 2 control: a walk that reaches builds no route-around, and its executionTrace output carries none", async () => {
    const sc = scenario("lookup-control-reached", { status: 404, json: NOT_FOUND });
    (sc.routes as Array<Record<string, unknown>>).find((x) => x["id"] === "hop:hopZ")!["respond"] = { json: { success: true, shape: "hopZ", body: { answer: "hopZ answered" } } };
    const r = await replay(sc);
    expect(r.record?.reached).toBe(true);
    expect(r.record?.routeArounds ?? []).toEqual([]);
    expect(r.walkTraceOutputs.length).toBeGreaterThanOrEqual(1);
    for (const w of r.walkTraceOutputs) expect(w.executionTrace[0].route_around).toBeNull();
  }, 120_000);
  test("503 (transient): recorded with its class, and it re-arms nothing either", async () => {
    const r = await replay(scenario("lookup-503", { status: 503, json: { error: "forward_failed", shape: "discoverByShapesQuery" } }));
    const walk1 = firstWalk(r.log);
    expect(walk1).toContain("— transient, recorded among the walk's failed producers");
    expect(walk1).not.toContain("RE-ATTEMPT");
    expect(lookupFailures(r)[0]!.reason).toContain("HTTP 503 no producer (transient)");
  }, 120_000);
});

describe("guard 1 (pure): a failed lookup never changes the walk's failure label", () => {
  const realFetch = globalThis.fetch;
  let walkFailureMode: (o: Record<string, unknown>) => { type: string; reason: string };
  beforeAll(async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch;
    process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
    walkFailureMode = ((await import("../src/index")) as Record<string, any>)["walkFailureMode"];
    globalThis.fetch = realFetch;
  });
  const base = { verdictReason: "goal not reached", missing: ["hopZ"], produced: ["goal"], satisfierFailures: new Map<string, string>(), pickOutputs: new Map<string, string[]>() };
  test("the lookup's entry in pickFailures is not a pick (it declares no outputs), so the label stays what it was without it", () => {
    const without = walkFailureMode({ ...base, pickFailures: new Map() });
    const withLookup = walkFailureMode({ ...base, pickFailures: new Map([["lookup:discoverByShapesQuery", "HTTP 404 no producer (non_transient): Not found"]]) });
    expect(without.type).toBe("cascading");
    expect(withLookup).toEqual(without);
  });
});

// A2 (agf_1x05yvmnxbee): NO learned-pathway producer is advertised (the store's /v2/goal-paths/recommend was a REST route
// with no resolve shape), so the walk asks nothing and records the absence among its failed producers on every walk.
describe.skipIf(!HERMETIC)("the learned-pathway absence is observable on the walk's own trace", () => {
  test("no recommend dial in the source; the absence is recorded once per walk, as a failed producer", () => {
    expect(SRC.match(/fetch\(`\$\{ACTIVITY_API_ENDPOINT\}\/v2\/goal-paths\/recommend`/g)?.length ?? 0).toBe(0);
    expect(SRC).not.toContain("async function recommendReachingPath(");
    expect(SRC.match(/pickFailures\.set\("lookup:learned-pathway", "learned-pathway lookup: no producer \(no shape advertised\)"\);/g)?.length).toBe(1);
  });
  test("read BY SHAPE from the walk execution's executionTrace output: route_around names the absence; no recommend request; 0 RE-ATTEMPT", async () => {
    const r = await replay(scenario("learned-pathway-absent", { status: 404, json: NOT_FOUND }));
    expect(r.requests.some((q) => q.url.includes("/v2/goal-paths/recommend"))).toBe(false);
    const ra = r.walkTraceOutputs[0]!.executionTrace[0].route_around;
    const f = (ra?.failed_producers ?? []).find((x: { producer: string }) => x.producer === "lookup:learned-pathway");
    expect(f?.reason).toBe("learned-pathway lookup: no producer (no shape advertised)");
    expect(firstWalk(r.log)).not.toContain("RE-ATTEMPT");
    expect(firstWalk(r.log)).not.toContain("would be re-eligible");
  }, 120_000);
});

// A4: the walk's executionTrace output is KEPT on its dispatch record (by impulse id, with its execution id) and SERVED
// through the existing goalWalkOutput shape after the walk ends; the body is goalWalkOutput's own.
describe.skipIf(!HERMETIC)("the walk's trace output is kept and served by goalWalkOutput", () => {
  test("resolve goalWalkOutput {dispatchId, impulseId: <walk execution id>-trace}: the executionTrace record, route_around included", async () => {
    const r = await replay(scenario("walk-trace-served", { status: 404, json: NOT_FOUND }));
    expect(r.walkTraceServed.length).toBe(r.walkTraceOutputs.length);
    expect(r.walkTraceServed.length).toBeGreaterThanOrEqual(1);
    const served = r.walkTraceServed[0]!;
    expect(served.status).toBe(200);
    const body = served.json.body;
    expect(Object.keys(body).sort()).toEqual(["chars", "content", "contentType", "dispatchId", "impulseId", "producedBy", "producerExecutionId", "shape", "status", "truncated"]);
    expect(body.shape).toBe("executionTrace");
    expect(body.producedBy).toBe("goal-host-vessel:walk");
    expect(body.producerExecutionId).toBe(r.walkTraceOutputs[0]!.executionId);
    const rec = JSON.parse(body.content);
    expect(rec.execution_id).toBe(r.walkTraceOutputs[0]!.executionId);
    // The kept copy is the engine-side record plus the delivery outcome of that record (A1).
    const { delivery, ...asDelivered } = rec;
    expect(asDelivered).toEqual(r.walkTraceOutputs[0]!.executionTrace[0]);
    expect(typeof delivery?.outcome).toBe("string");
    expect((rec.route_around?.failed_producers ?? []).some((f: { producer: string }) => f.producer === "lookup:learned-pathway")).toBe(true);
  }, 120_000);
});

// A3: no producer of the learned DELIVERABLE-shapes vocabulary is advertised (the store's deliverable-shapes route was
// REST only), so the walk's inference vocabulary asks nothing for it and every walk records the absence.
describe.skipIf(!HERMETIC)("the deliverable-shapes absence is observable on the walk's own trace", () => {
  test("no deliverable-shapes dial in the source; the absence is recorded once per walk", () => {
    expect(SRC.match(/\/v2\/activities\/deliverable-shapes`/g)?.length ?? 0).toBe(0);
    expect(SRC).not.toContain("async function fetchLearnedDeliverableShapes(");
    expect(SRC.match(/pickFailures\.set\("lookup:deliverable-shapes", "deliverable-shapes lookup: no producer \(no shape advertised\)"\);/g)?.length).toBe(1);
  });
  test("read BY SHAPE from the walk execution's executionTrace output: route_around names the absence; no request; 0 RE-ATTEMPT", async () => {
    const r = await replay(scenario("deliverable-shapes-absent", { status: 404, json: NOT_FOUND }));
    expect(r.requests.some((q) => q.url.includes("/v2/activities/deliverable-shapes"))).toBe(false);
    const ra = r.walkTraceOutputs[0]!.executionTrace[0].route_around;
    const f = (ra?.failed_producers ?? []).find((x: { producer: string }) => x.producer === "lookup:deliverable-shapes");
    expect(f?.reason).toBe("deliverable-shapes lookup: no producer (no shape advertised)");
    expect(firstWalk(r.log)).not.toContain("RE-ATTEMPT");
  }, 120_000);
});

// A1: the walk delivers its own executionTrace output by a search -> call hop (discovery /resolve,
// activityExecutionTrace_write); the outcome is kept with the walk's trace (goalWalkOutput) and tapped, never fails it.
const deliverRoute = (respond: unknown) => ({ id: "discovery:trace-write", method: "POST", type: "activityExecutionTrace_write", respond });
// The store's confirming answer (activity-api: the resolve envelope around the execution-traces POST / body) for the
// harness's first walk execution id (the harness's ids are seeded, so the first walk is always this one).
const FIRST_WALK = "exec_y9nyvr27";
const storedBody = (id: string) => ({ json: { success: true, content: JSON.stringify({ success: true, execution_id: id, stored: true }) } });
const keptDelivery = (r: Replay) => JSON.parse(r.walkTraceServed[0]!.json.body.content).delivery;
describe.skipIf(!HERMETIC)("the walk delivers its own trace and keeps the outcome", () => {
  test("2xx: delivered; the hop carries the store's required fields; the delivered record does not carry the outcome", async () => {
    const r = await replay(scenario("deliver-2xx", { status: 404, json: NOT_FOUND }, [deliverRoute(storedBody(FIRST_WALK))]));
    expect(r.walkTraceOutputs[0]!.executionId).toBe(FIRST_WALK);
    const sent = r.requests.find((q) => q.body?.pointer?.type === "activityExecutionTrace_write")!;
    const td = sent.body.pointer.traceData;
    expect(td.execution_id).toBe(r.walkTraceOutputs[0]!.executionId);
    expect(td.template_id).toBe("goal-host-vessel:walk");
    expect(td.execution_trace.execution_id).toBe(td.execution_id);
    expect(td.execution_trace.delivery).toBeUndefined();
    expect(keptDelivery(r)).toEqual({ status: 200, class: "delivered", outcome: "delivered" });
    expect(r.log).toContain("delivered via activityExecutionTrace_write (HTTP 200)");
    expect(r.walkTraceOutputs[0]!.executionTrace[0].delivery).toBeUndefined();
  }, 120_000);
  test("403 caller_lacks_write_scope: kept as that outcome; the walk is not failed and nothing re-arms", async () => {
    const r = await replay(scenario("deliver-403", { status: 404, json: NOT_FOUND }, [deliverRoute({ status: 403, json: { error: "caller_lacks_write_scope", shape: "activityExecutionTrace_write" } })]));
    expect(keptDelivery(r)).toMatchObject({ status: 403, class: "non_transient", outcome: "caller_lacks_write_scope" });
    expect(r.log).toContain("NOT delivered via activityExecutionTrace_write: caller_lacks_write_scope");
    expect(firstWalk(r.log)).not.toContain("RE-ATTEMPT");
    expect(String(r.record?.goalReachReason ?? "")).not.toContain("activityExecutionTrace_write");
  }, 120_000);
  test("404 (no producer): kept as no_producer_or_unreachable; the three outcomes are distinct by text", async () => {
    const r = await replay(scenario("deliver-404", { status: 404, json: NOT_FOUND }, [deliverRoute({ status: 404, json: { error: "Not found", shape: "activityExecutionTrace_write" } })]));
    expect(keptDelivery(r)).toMatchObject({ status: 404, class: "non_transient", outcome: "no_producer_or_unreachable" });
    expect(firstWalk(r.log)).not.toContain("RE-ATTEMPT");
    expect(new Set(["delivered", "caller_lacks_write_scope", "no_producer_or_unreachable"]).size).toBe(3);
  }, 120_000);
});

// A5: walk-log taps (no behaviour change): lines that were console-only now reach the dispatch record's walkLog, the
// selection's top draws and W1's cap / step-budget refusals are tapped. The oracles' ABSTAINED lines run outside the
// walk scope and stay console-only.
describe.skipIf(!HERMETIC)("walk-log taps reach the dispatch record", () => {
  test("reach-input, recordGoalPath PRECONDITIONS and walk-activity: dispatched are in the record's walkLog", async () => {
    const sc = scenario("walklog-taps", { status: 404, json: NOT_FOUND }, [deliverRoute(storedBody(FIRST_WALK))]);
    (sc.routes as Array<Record<string, unknown>>).find((x) => x["id"] === "hop:hopZ")!["respond"] = { json: { success: true, shape: "hopZ", body: { answer: "hopZ answered" } } };
    const r = await replay(sc);
    expect(r.record?.reached).toBe(true);
    const log = r.walkLog.join("\n");
    expect(log).toContain("walk-activity: dispatched ");
    expect(log).toContain("delivered via activityExecutionTrace_write (HTTP 200)");
    expect(log).toContain("reach-input: cmdEvidenceLen=");
    expect(log).toContain("recordGoalPath PRECONDITIONS chain=");
  }, 120_000);
  test("the selection draws and the W1 cap / step-budget refusals are tapped (once per pool version)", () => {
    expect(SRC).toContain("selection draws (top ${Math.min(5, candidates.length)} of ${candidates.length})");
    expect(SRC.match(/if \(!reattemptRefusals\.has\(tapKey\)\) tap\(`\[goal-host-vessel\] walk\(\$\{opts\.surface\}\): re-attempt refused at pool version/g)?.length).toBe(2);
    expect(SRC).toContain("tap(`[goal-host-vessel] walk(${opts.surface}): reach-input: cmdEvidenceLen=");
    expect(SRC).toContain("tap(`[goal-host-vessel] recordGoalPath PRECONDITIONS chain=");
  });
});

// A shell executor scenario: one vessel serves shellResult, the corrector's commands come from llm:arg-extraction.
const PS = "ps -e | wc -l";
const shellScenario = (id: string, extraRoutes: unknown[] = []) => ({
  id,
  description: "executor repeat test (not part of the verdict-diff corpus)",
  fleet: { vessels: [{ id: "tools-vessel", endpoint: "http://tools.test.invalid", resolve_endpoint: "/v2/impulses/resolve", shapes: ["shellResult"] }] },
  routes: [
    { id: "discovery:producer-lookup", method: "POST", type: "discoverByShapesQuery", respond: { status: 404, json: NOT_FOUND } },
    ...extraRoutes,
    { id: "llm:target-inference", method: "POST", caller: "goal-host:goal_target_inference", respond: { llm: JSON.stringify({ target_shapes: ["shellResult"], confidence: 0.9, alternatives: [] }) } },
    { id: "schema:shellResult", method: "POST", type: "resolver_schema", body: ['"shape":"shellResult"'], respond: { json: { success: true, shape: "resolver_schema", body: { shape: "shellResult", known: true, fields: [{ name: "command", required: true, type: "string" }] } } } },
    { id: "llm:arg-extraction", method: "POST", caller: "goal-host:pointer_arg_extraction", respond: { llm: JSON.stringify({ command: PS }) } },
    { id: "tools:shell", method: "POST", type: "shellResult", respond: { json: { success: true, shape: "shellResult", body: { stdout: "", stderr: "bash: ps: command not found", exit_code: 127 } } } },
    { id: "judge", method: "POST", caller: "goal-host:reach_verification", respond: { llm: "{\"reached\": false, \"reason\": \"no count\", \"completion_shapes\": []}" } },
    { id: "floor:answer", method: "POST", caller: "goal-host:floor_tool_loop", respond: { json: { success: true, shape: "llmTextCompletion", body: { text: "UNKNOWN" } } } },
  ],
  steps: [{ op: "runGoal", body: { goal: "Count the running processes on this host." } }],
});
const shellSends = (r: Replay) => r.requests.filter((q) => q.body?.impulse?.pointer?.type === "shellResult" || q.body?.pointer?.type === "shellResult");


// F1 (agf_oe9rj34wgpt9): the walk's executor sends, including runs that never became a step, are in its trace output as
// `sends` (attempts keeps its step meaning), bounded and credential-redacted, in the kept copy and the delivered body.
describe.skipIf(!HERMETIC)("F1: the walk's executor sends are in its trace output", () => {
  const CMDS = ["echo verdict-diff-key | wc -c", "echo mb-SEEDEDKEY0123456789 | wc -c", "ps -e | wc -l"];
  const sc = () => {
    const s = shellScenario("executor-sends");
    const rs = s.routes as Array<Record<string, unknown>>;
    const arg = rs.find((x) => x["id"] === "llm:arg-extraction")!;
    delete arg["respond"];
    arg["sequence"] = [...CMDS, ...CMDS].map((c) => ({ llm: JSON.stringify({ command: c }) }));
    rs.find((x) => x["id"] === "tools:shell")!["respond"] = { json: { success: true, shape: "shellResult", body: { stdout: "", stderr: "bash: mb-STDERRKEY987654321: command not found", exit_code: 127 } } };
    return s;
  };
  test("N degenerate shell runs give N send entries (attempts stays 0 steps), each with command, exit status and stderr", async () => {
    const r = await replay(sc());
    // every walk execution's own output (engine side; one dispatch's walks are also kept and served below)
    const all = r.walkTraceOutputs.map((w) => w.executionTrace[0]);
    const egress = all.flatMap((k) => (k.sends ?? []).filter((x: { refused_before_egress?: boolean }) => !x.refused_before_egress));
    const kept = r.walkTraceServed.filter((x) => x.status === 200).map((x) => JSON.parse(x.json.body.content));
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept[0].sends).toEqual(all[0].sends);
    expect(egress.length).toBeGreaterThanOrEqual(3);
    expect(egress.length).toBe(shellSends(r).length);
    for (const k of kept) expect(k.attempts).toBe(0);
    for (const x of egress) {
      expect(x.producer).toBe("satisfier:shellResult");
      expect(typeof x.command).toBe("string");
      expect(x.exit_status).toBe(127);
      expect(String(x.stderr_excerpt)).toContain("command not found");
      expect(String(x.command).length).toBeLessThanOrEqual(512);
    }
  }, 120_000);
  test("a key-like value in the command and in stderr appears in neither the kept trace nor the delivered body", async () => {
    const r = await replay(sc());
    const kept = r.walkTraceServed.filter((x) => x.status === 200).map((x) => x.json.body.content).join("\n");
    expect(kept.length).toBeGreaterThan(0);
    const delivered = JSON.stringify(r.requests.filter((q) => q.body?.pointer?.type === "activityExecutionTrace_write").map((q) => q.body.pointer.traceData));
    for (const text of [kept, delivered]) {
      expect(text).toContain("[redacted]");
      for (const secret of ["verdict-diff-key", "mb-SEEDEDKEY0123456789", "mb-STDERRKEY987654321"]) expect(text).not.toContain(secret);
    }
  }, 120_000);
});

// F2 (agf_8aeyennv2jqv): a line the walk taps is on its dispatch record at once, inside the same iteration, not at the
// next per-iteration mirror. The self-correction loop runs inside one iteration: its "attempt 1" line must already be on
// the record (what goalWalkState serves) when the next correction's command is sent.
describe.skipIf(!HERMETIC)("F2: walk-log taps reach the record within the iteration", () => {
  test("MUST-FAIL: at the third shell send, the record's walk log already carries the first correction's line", async () => {
    const s = shellScenario("walklog-live");
    const rs = s.routes as Array<Record<string, unknown>>;
    const arg = rs.find((x) => x["id"] === "llm:arg-extraction")!;
    delete arg["respond"];
    arg["sequence"] = ["ps -e | wc -l", "ps aux | wc -l", "ls /proc | wc -l", "ps -A | wc -l"].map((c) => ({ llm: JSON.stringify({ command: c }) }));
    const r = await replay(s);
    expect(r.walkLogAtSend.length).toBeGreaterThanOrEqual(3);
    const atThird = r.walkLogAtSend[2]!.walkLog.join("\n");
    expect(atThird).toContain("cold-command self-correction attempt 1");
  }, 120_000);
});

// (a) agf_2aezfw2lg9ui: the executor's extract-guard asks for the value through routedComplete (llm_completion producers
// discovered at use time), not the llm_completion_dispatch wrapper whose only producer is gone.
describe.skipIf(!HERMETIC)("(a): the extract-guard's value extraction goes through routedComplete", () => {
  test("MUST-FAIL: zero llm_completion_dispatch requests and one llm_completion request from the extract-guard", async () => {
    const s = shellScenario("extract-guard-routed");
    const rs = s.routes as Array<Record<string, unknown>>;
    const DUMP = Array.from({ length: 40 }, (_, i) => `entry ${String.fromCharCode(97 + (i % 26))} has the status ok and the owner team`).join("\n");
    rs.find((x) => x["id"] === "tools:shell")!["respond"] = { json: { stdout: DUMP, stderr: "", exit_code: 0 } };
    rs.unshift({ id: "llm:extract-value", method: "POST", caller: "goal-host:uf_tool_llm_completion", respond: { llm: "team" } });
    (s.steps[0]!.body as { goal: string }).goal = "How many entries does the status report list?";
    const r = await replay(s);
    expect(r.log).toMatch(/extract-guard: degMatch=true/);
    const typed = (t: string) => r.requests.filter((q) => q.body?.type === t || q.body?.impulse?.pointer?.type === t || q.body?.pointer?.type === t);
    expect(typed("llm_completion_dispatch").length).toBe(0);
    // one llm_completion request per extract-guard firing (each firing asks once)
    const firings = r.log.split("extract-guard: degMatch=true").length - 1;
    expect(firings).toBeGreaterThanOrEqual(1);
    expect(r.requests.filter((q) => q.body?.caller === "goal-host:uf_tool_llm_completion" && q.body?.type === "llm_completion").length).toBe(firings);
  }, 120_000);
});

// agf_60oyt7cvc7pt: a 2xx counts as delivered only when the store's body confirms it stored this execution id.
describe.skipIf(!HERMETIC)("delivery is confirmed on the store's body", () => {
  test("MUST-FAIL: a 200 whose body carries an error (or a duplicate / system-track answer) is accepted_unconfirmed, with the body text", async () => {
    const r = await replay(scenario("deliver-200-error", { status: 404, json: NOT_FOUND }, [deliverRoute({ json: { success: false, error: "write resolver failed (status 500)" } })]));
    const d = keptDelivery(r);
    expect(d.outcome).toBe("accepted_unconfirmed");
    expect(d.status).toBe(200);
    expect(String(d.detail)).toContain("write resolver failed");
    expect(r.log).toContain("accepted but NOT confirmed via activityExecutionTrace_write (HTTP 200)");
    const dup = await replay(scenario("deliver-200-duplicate", { status: 404, json: NOT_FOUND }, [deliverRoute({ json: { success: true, content: JSON.stringify({ success: true, stored: false, duplicate: true }) } })]));
    expect(keptDelivery(dup).outcome).toBe("accepted_unconfirmed");
  }, 120_000);
  test("a 200 whose body confirms the stored execution id is delivered", async () => {
    const r = await replay(scenario("deliver-200-stored", { status: 404, json: NOT_FOUND }, [deliverRoute(storedBody(FIRST_WALK))]));
    expect(r.walkTraceOutputs[0]!.executionId).toBe(FIRST_WALK);
    expect(keptDelivery(r)).toEqual({ status: 200, class: "delivered", outcome: "delivered" });
  }, 120_000);
});

// F4 (agf_4twee11e4aik): within ONE satisfier attempt, a corrector that rewrites the command X -> X does not re-run X.
// The executor's own degeneracy verdict fails the send that produced it, the identical-instance check also reads the
// attempt's own failed sends, and the self-correction loop stops on that refusal. An ok send (an LLM re-send) is free.
describe.skipIf(!HERMETIC)("F4: an identical rewrite within one attempt is not re-run", () => {
  test("MUST-FAIL: X -> X is refused before egress with the identical-instance line, and the corrections stop", async () => {
    const r = await replay(shellScenario("executor-repeat"));
    const walk1 = firstWalk(r.log);
    const sends = shellSends(r).filter((q) => JSON.stringify(q.body).includes(PS));
    // One egress of the command per walk execution (the dispatch's retry is its own walk with a fresh ledger).
    const walks = r.log.split("walk-activity: dispatched ").length - 1;
    expect(walks).toBeGreaterThanOrEqual(1);
    expect(sends.length).toBe(walks);
    expect(walk1).toContain("NOT sent — identical instance already failed in this walk");
    expect(walk1).toContain("repeated an identical instance — stopping the corrections");
  }, 120_000);
  test("no spin: the refused rewrite ends the corrections at once (no second correction, no new egress)", async () => {
    const r = await replay(shellScenario("executor-repeat-nospin"));
    expect(r.log).not.toMatch(/self-correction attempt 2 /);
    expect(r.log.split("repeated an identical instance — stopping the corrections").length - 1).toBe(r.log.split("walk-activity: dispatched ").length - 1);
    expect(shellSends(r).length).toBe(r.log.split("walk-activity: dispatched ").length - 1);
  }, 120_000);
});

// F1 (widened): the kept executionTrace carries what the walk worked toward and with: the dispatch's recalled concept
// ids, the walk's target set, and W1's unmet inputs and bound demands, each bounded and redacted.
describe.skipIf(!HERMETIC)("F1 widened: the walk's targets, recalled concepts and demands are on its trace", () => {
  test("read by shape from goalWalkOutput's kept copy: target, recalled_concept_ids, unmet_inputs, bound_demands", async () => {
    const sc = scenario("walk-context", { status: 404, json: NOT_FOUND });
    const rs = sc.routes as Array<Record<string, unknown>>;
    rs.find((x) => x["id"] === "schema:hopZ")!["respond"] = { json: { success: true, shape: "resolver_schema", body: { shape: "hopZ", known: true, fields: [{ name: "evidence", required: true, type: "string", from_shape: "evidenceRecord" }] } } };
    const r = await replay(sc);
    const served = r.walkTraceServed.find((x) => x.status === 200)!;
    expect(served.json.body.shape).toBe("executionTrace");
    const rec = JSON.parse(served.json.body.content);
    expect(rec.target).toContain("hopZ");
    expect(Array.isArray(rec.recalled_concept_ids)).toBe(true);
    expect(Array.isArray(rec.bound_demands)).toBe(true);
    expect(rec.unmet_inputs.some((u: { hop: string; field: string; shape: string }) => u.hop === "hopZ" && u.field === "evidence" && u.shape === "evidenceRecord")).toBe(true);
    expect(rec.target).toContain("evidenceRecord");
  }, 120_000);
});

// agf_fvahxniq3wix: the store keeps a delivered trace's tasks only from execution_trace.tasks / tasks and the rest only
// from metadata, so the walk's hop maps its sends to tasks and carries its own record under metadata.walk.
describe.skipIf(!HERMETIC)("the delivered walk trace speaks the store's contract", () => {
  test("MUST-FAIL: the POST body for a walk with sends carries tasks.length == sends.length and metadata.walk", async () => {
    const s = shellScenario("deliver-store-contract");
    const rs = s.routes as Array<Record<string, unknown>>;
    const arg = rs.find((x) => x["id"] === "llm:arg-extraction")!;
    delete arg["respond"];
    arg["sequence"] = ["ps -e | wc -l", "ps aux | wc -l", "ls /proc | wc -l"].map((c) => ({ llm: JSON.stringify({ command: c }) }));
    const r = await replay(s);
    const tds = r.requests.filter((q) => q.body?.pointer?.type === "activityExecutionTrace_write").map((q) => q.body.pointer.traceData);
    expect(tds.length).toBeGreaterThanOrEqual(1);
    const td = tds[0];
    const sends = td.execution_trace.sends as Array<{ producer: string; ok: boolean; refused_before_egress?: boolean }>;
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(td.tasks)).toBe(true);
    expect(td.tasks.length).toBe(sends.length);
    td.tasks.forEach((t: Record<string, unknown>, i: number) => {
      expect(t["task_id"]).toBe(`send-${i + 1}`);
      expect(t["resolver_id"]).toBe(sends[i]!.producer);
      expect(t["success"]).toBe(sends[i]!.ok);
      if (sends[i]!.refused_before_egress) { expect(t["status"]).toBe("skipped"); expect(t["skipped"]).toBe(true); }
      else expect(String(t["description"])).toContain("exit 127");
    });
    expect(td.metadata.walk.attempts).toBe(td.execution_trace.attempts);
    expect(td.metadata.walk.route_around).toEqual(td.execution_trace.route_around);
    expect(td.metadata.walk.target).toEqual(td.execution_trace.target);
  }, 120_000);
});

// F3 (agf_7b4l8praaak5): a PINNED dispatch whose template cannot be fetched (a dead template store) no longer reaches the
// recovery loop's uncaught template fetch: it goes through the walk, which takes no step and ends unreached naming the pin.
describe.skipIf(!HERMETIC)("F3: an unavailable pin ends unreached in the walk", () => {
  const PIN = "development-vessel:probe-untraversed-edge";
  const pinned = (id: string, templateRespond: Record<string, unknown>) => {
    const s = scenario(id, { status: 404, json: NOT_FOUND });
    (s.routes as Array<Record<string, unknown>>).unshift({ id: "aapi:template", method: "GET", urlRegex: "/v2/activities/templates/", respond: templateRespond });
    (s.steps[0]!.body as Record<string, unknown>)["targetTemplateId"] = PIN;
    return s;
  };
  test("MUST-FAIL: one walk, unreached with the pin's reason on its trace, no escaped error, no derivation", async () => {
    const r = await replay(pinned("pin-dead-store", { throw: "ECONNREFUSED: Unable to connect" }));
    expect(r.log.split("walk-activity: dispatched ").length - 1).toBe(1);
    expect(r.log).not.toContain("async /run-goal error");
    const served = r.walkTraceServed.find((x) => x.status === 200)!;
    expect(served.json.body.shape).toBe("executionTrace");
    const rec = JSON.parse(served.json.body.content);
    expect(rec.reached).toBe(false);
    expect(rec.goal_reach_reason).toBe(`pinned template ${PIN} unavailable`);
    const f = (rec.route_around?.failed_producers ?? []).find((x: { producer: string }) => x.producer === `pin:${PIN}`);
    expect(String(f?.reason)).toContain("ECONNREFUSED");
    expect(rec.attempts).toBe(0);
    expect(rec.sends).toEqual([]);
    expect(r.log).not.toContain("walk rawResolve");
    expect(r.record?.reached).toBe(false);
    expect(r.record?.goalReachReason).toBe(`pinned template ${PIN} unavailable`);
  }, 120_000);
  // EXPECTATION FLIPPED (agf_l9iq6yssnrrw): a served pin runs as the walk's first pick, no longer in the recovery loop.
  test("control: a served pin runs as the walk's first pick", async () => {
    const r = await replay(pinned("pin-served", { json: { id: PIN, name: "probe", inputShapes: ["goal"], outputShapes: ["hopZ"], tasks: [{ id: "t1", description: "hop", resolver: "hopZ" }] } }));
    expect(r.log).not.toContain(`pinned template ${PIN} unavailable`);
    expect(r.log.split("walk-activity: dispatched ").length - 1).toBe(1);
    expect(r.log).toContain(`pinned template ${PIN} is this walk's first pick`);
  }, 120_000);
});

// agf_l9iq6yssnrrw: an AVAILABLE pin runs AS THE WALK: the fetched template is the walk's first pick, run by the walk's
// own template step (traced as a step of the walk execution), and the walk then goes on toward the goal's targets.
// A pinned step is not a selection: it credits no posterior. The recovery loop's pin branch is gone.
describe.skipIf(!HERMETIC)("a served pin runs as the walk", () => {
  const PIN = "tpl-pinned-noop";
  const NOOP = { id: PIN, name: "pinned noop", inputShapes: ["goal"], outputShapes: [], tasks: [{ id: "t1", description: "noop", resolver: "noop" }] };
  const served = (id: string, judgeReached: boolean) => {
    const s = scenario(id, { status: 404, json: NOT_FOUND });
    const rs = s.routes as Array<Record<string, unknown>>;
    rs.unshift({ id: "aapi:template", method: "GET", urlRegex: "/v2/activities/templates/", respond: { json: NOOP } });
    rs.find((x) => x["id"] === "judge")!["respond"] = { llm: JSON.stringify({ reached: judgeReached, reason: judgeReached ? "hop answered" : "the answer does not address the goal", completion_shapes: [] }) };
    (s.steps[0]!.body as Record<string, unknown>)["targetTemplateId"] = PIN;
    return s;
  };
  const feedbackFor = (r: Replay, id: string) => r.requests.filter((q) => q.url.includes("/v2/activities/feedback") && q.body?.activity_id === id);
  test("MUST-FAIL: the served pin is walk step 1 (its run is a child of the walk execution), one walk, no recovery-loop run", async () => {
    const r = await replay(served("pin-walk-step", true));
    expect(r.log.split("walk-activity: dispatched ").length - 1).toBe(1);
    expect(r.log).toContain(`pinned template ${PIN} is this walk's first pick`);
    const walkId = r.walkTraceOutputs[0]!.executionId;
    const pinRun = r.requests.find((q) => q.body?.template_id === PIN && q.url.includes("/v2/activities/execution-traces"));
    expect(pinRun?.body?.parent_execution_id).toBe(walkId);
    expect(r.walkTraceServed.find((x) => x.status === 200)!.json.body.shape).toBe("executionTrace");
    expect(r.log).not.toMatch(/goal-reach\([^)]*\) attempt \d+\/\d+/);
    expect(r.requests.filter((q) => q.url.includes(`/v2/activities/templates/${PIN}`)).length).toBe(1);
  }, 120_000);
  test("a pinned step credits no posterior; a selector pick still does", async () => {
    const r = await replay(served("pin-no-credit", false));
    expect(feedbackFor(r, PIN).length).toBe(0);
    // Both credit sites skip a pinned step (here the symmetric β-withhold rule fires first, so the guard is also pinned).
    expect(SRC).toContain("} else if (pinnedStepIds.has(lastPick)) {");
    expect(SRC).toContain("if (pinnedStepIds.has(_stepId)) { tap(");
    // Control: a corpus walk whose selector pick (satisfier:shellResult) is graded hollow by a deterministic oracle.
    const c = JSON.parse(readFileSync(join(HARNESS_DIR, "scenarios", "oracle-count-files-mismatch.json"), "utf8"));
    const rc = await replay(c);
    expect(feedbackFor(rc, "satisfier:shellResult").length).toBeGreaterThanOrEqual(1);
  }, 240_000);
  test("the recovery loop's pin branch is gone and every dispatch with a goal walks (callerPinned alone included)", () => {
    expect(SRC).toContain("let nextTarget: string | undefined = (goal ? undefined : opts.firstTarget) ?? authoredFallbackTarget;");
    expect(SRC).not.toContain("let nextTarget: string | undefined = opts.firstTarget ?? authoredFallbackTarget;");
    expect(SRC).not.toMatch(/if \(goal && \(\(!opts\.callerPinned/);
    expect(SRC).toContain("      if (_pin) return walk;");
  });
});
