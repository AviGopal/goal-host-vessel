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

interface Replay { log: string; record: any; requests: Array<{ url: string; body: any }>; walkTraceOutputs: Array<{ executionId: string; executionTrace: any[] }>; walkTraceServed: Array<{ status?: number; json?: any }>; walkLog: string[] }
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
    const side = existsSync(logPath) ? (JSON.parse(readFileSync(logPath, "utf8")) as { logs?: string[]; walkTraceOutputs?: Replay["walkTraceOutputs"]; walkTraceServed?: Replay["walkTraceServed"] }) : {};
    return { log: (side.logs ?? []).join("\n"), record: rec.steps?.[0]?.record ?? null, requests: rec.requests ?? [], walkTraceOutputs: side.walkTraceOutputs ?? [], walkTraceServed: side.walkTraceServed ?? [], walkLog: rec.steps?.[0]?.walkLog ?? [] };
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
const keptDelivery = (r: Replay) => JSON.parse(r.walkTraceServed[0]!.json.body.content).delivery;
describe.skipIf(!HERMETIC)("the walk delivers its own trace and keeps the outcome", () => {
  test("2xx: delivered; the hop carries the store's required fields; the delivered record does not carry the outcome", async () => {
    const r = await replay(scenario("deliver-2xx", { status: 404, json: NOT_FOUND }, [deliverRoute({ json: { success: true, shape: "activityExecutionTrace_write_result" } })]));
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
    const sc = scenario("walklog-taps", { status: 404, json: NOT_FOUND }, [deliverRoute({ json: { success: true } })]);
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
