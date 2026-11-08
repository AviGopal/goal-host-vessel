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

interface Replay { log: string; record: any; requests: Array<{ url: string; body: any }>; walkTraceOutputs: Array<{ executionId: string; executionTrace: any[] }> }
async function replay(sc: unknown): Promise<Replay> {
  const ws = mkdtempSync(join(tmpdir(), "producer-lookup-"));
  try {
    const scPath = join(ws, "scenario.json");
    const out = join(ws, "out.json");
    writeFileSync(scPath, JSON.stringify(sc));
    const proc = Bun.spawn([process.execPath, join(HARNESS_DIR, "child.ts"), TREE, scPath, DEFAULTS_PATH, out], { cwd: ws, env: childEnv(ws, { VD_WALK_TRACE_OUTPUTS: "1" }), stdout: "pipe", stderr: "pipe" });
    const [code, , stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (!existsSync(out)) throw new Error(`child produced no output (exit ${code}): ${stderr.slice(-1500)}`);
    const rec = JSON.parse(readFileSync(out, "utf8")) as { fatal?: string; requests?: Replay["requests"]; steps?: Array<{ record?: unknown }> };
    if (rec.fatal) throw new Error(`child fatal: ${rec.fatal}`);
    const logPath = out.replace(/\.json$/, ".log.json");
    const side = existsSync(logPath) ? (JSON.parse(readFileSync(logPath, "utf8")) as { logs?: string[]; walkTraceOutputs?: Replay["walkTraceOutputs"] }) : {};
    return { log: (side.logs ?? []).join("\n"), record: rec.steps?.[0]?.record ?? null, requests: rec.requests ?? [], walkTraceOutputs: side.walkTraceOutputs ?? [] };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** H5's shape (one hop that keeps failing, walkBudget max_attempts_per_producer 5), with discovery answering the
 *  producer lookup with `lookup`. */
const scenario = (id: string, lookup: { status: number; json: unknown }) => ({
  id,
  description: "producer lookup test (not part of the verdict-diff corpus)",
  fleet: { vessels: [
    { id: "hop-vessel", endpoint: "http://hop-vessel.test.invalid", resolve_endpoint: "/v2/impulses/resolve", shapes: ["hopZ"] },
    { id: "budget-vessel", endpoint: "http://budget.test.invalid", resolve_endpoint: "/v2/impulses/resolve", shapes: ["walkBudget"] },
  ] },
  routes: [
    { id: "discovery:producer-lookup", method: "POST", type: "discoverByShapesQuery", respond: lookup },
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
