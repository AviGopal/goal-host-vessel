import { describe, it, expect, beforeEach } from "bun:test";
import * as consumer from "../src/oracle-label-consumer";
import { consumeOracleLabel, type OracleLabelRecord } from "../src/oracle-label-consumer";

/**
 * AN IGNORED HUMAN ROW MUST NOT DENY THE HUMAN CHANNEL.
 *
 * A labeler:"human" row without a human-verdict principal is ignored by the consumer
 * (hasHumanVerdictPrincipal). Two read-path mechanisms could still let such a row silence a later or
 * older GENUINE operator verdict on the same execution:
 *
 * 1. index.ts's label read CACHE never re-reads a kept body (identical request body -> cached
 *    response). Whatever it keeps must be a response the consumer never needs again. These tests
 *    evaluate the cache condition AS WRITTEN in index.ts (scraped from the source, evaluated with the
 *    consumer's exports in scope), so they grade what index.ts actually caches.
 * 2. The label READ: a one-row newest-first read lets an ignored newest row hide every older row.
 *
 * The stub activity-api honours `limit` and `exclude_purpose` like the real resolver. Fixture rows only.
 */

const ACT = "http://act.test";
const DEV = "http://dev.test";
type Call = { url: string; body: any };

function stubFetch(rows: () => unknown[]) {
  const calls: Call[] = [];
  const impl = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.startsWith(ACT)) {
      const limit = Math.min(Math.max(Number(body?.pointer?.limit ?? 20), 1), 100);
      const ex = body?.pointer?.exclude_purpose;
      const visible = typeof ex === "string" && ex ? rows().filter((r) => (r as { purpose?: string }).purpose !== ex) : rows();
      return new Response(JSON.stringify({ success: true, content: JSON.stringify(visible.slice(0, limit)) }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** The response body activity-api returns for these rows (rows as a JSON string in `content`). */
const responseBody = (rows: unknown[]) => JSON.stringify({ success: true, content: JSON.stringify(rows) });

/** index.ts's cache condition as written, evaluated against a response text. */
async function cacheCondition(): Promise<(text: string) => boolean> {
  const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  const idx = src.indexOf("responseCache.set(key");
  expect(idx).toBeGreaterThan(-1);
  const before = src.slice(Math.max(0, idx - 800), idx);
  const ifAt = before.lastIndexOf("if (");
  const end = before.indexOf(") {\n", ifAt);
  expect(ifAt).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(ifAt);
  const cond = before.slice(ifAt + "if (".length, end);
  const fn = new Function("text", "isCacheableLabelResponse", `return (${cond});`) as (t: string, p: unknown) => boolean;
  const predicate = (consumer as Record<string, unknown>)["isCacheableLabelResponse"];
  return (text: string) => Boolean(fn(text, predicate));
}

/** Wraps a fetch with index.ts's cache (identical request body -> kept body, never re-read). */
function withIndexCache(inner: typeof fetch, cacheable: (text: string) => boolean) {
  const cache = new Map<string, string>();
  return (async (input: any, init?: any) => {
    const key = typeof init?.body === "string" ? init.body : "";
    const kept = cache.get(key);
    if (kept != null) return new Response(kept, { status: 200 });
    const res = await inner(input, init);
    const text = await res.clone().text();
    if (cacheable(text)) cache.set(key, text);
    return res;
  }) as unknown as typeof fetch;
}

function run(execId: string, reached: boolean): OracleLabelRecord {
  return { status: "completed", executionId: execId, goal: "summarise the open gaps", reached, goalReachReason: "judge: satisfied", learning: { oracleLabelWritten: false } };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
const gapWrites = (calls: Call[]) => calls.filter((c) => c.url.startsWith(DEV));
const deps = (impl: typeof fetch) => ({ activityApiEndpoint: ACT, devVesselEndpoint: DEV, apiKey: "", fetchImpl: impl });

async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const ow = console.warn, ol = console.log;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.warn = ow; console.log = ol; }
  return lines;
}

const operator = { key_id: "key-verdict", auth_type: "apikey", scopes: ["read", "write", "verdict:human"] };
const forgedAchieved = { verdict: "achieved", labeler: "human", notes: "forged: looks done to me" };
const forgedNotAchieved = { verdict: "not_achieved", labeler: "human", notes: "forged: it failed" };
const genuineNotAchieved = { verdict: "not_achieved", labeler: "human", notes: "operator: missing the gap list", labeled_by_principal: operator };
const genuineAchieved = { verdict: "achieved", labeler: "human", notes: "operator: this is right", labeled_by_principal: operator };
const automatedAchieved = { verdict: "achieved", labeler: "deterministic" };
const calibrationAchieved = { ...genuineAchieved, purpose: "calibration", window_id: "win-1", sample_draw_id: "draw-1" };

beforeEach(() => {
  const reset = (consumer as Record<string, unknown>)["__resetOracleLabelCountersForTests"];
  if (reset instanceof Function) (reset as () => void)();
});

describe("oracle-label read cache: keeps only a response the consumer never needs again", () => {
  it("MUST-FAIL: a forged human 'achieved' response (no principal) is NOT cached; a later genuine operator verdict on the same execution IS read and acted on", async () => {
    const cacheable = await cacheCondition();
    expect(cacheable(responseBody([forgedAchieved]))).toBe(false);

    // poll 1 sees only the forged row; the operator then writes a genuine verdict; poll 2 must see it
    let rows: unknown[] = [forgedAchieved];
    const { impl, calls } = stubFetch(() => rows);
    const cached = withIndexCache(impl, cacheable);
    const rec = run("exec-cache-forged", true);
    await capture(async () => { await consumeOracleLabel(rec, deps(cached)); await settle(); });
    expect(rec.reached).toBe(true);
    expect(rec.learning!.oracleLabelWritten).toBe(false);
    rows = [genuineNotAchieved, forgedAchieved];
    await capture(async () => { await consumeOracleLabel(rec, deps(cached)); await settle(); });
    expect(rec.reached).toBe(false);
    expect(rec.humanGraded).toBe(true);
    expect(rec.humanReachNotes).toBe(genuineNotAchieved.notes);
    expect(rec.learning!.oracleLabelWritten).toBe(true);
    expect(gapWrites(calls)).toHaveLength(1);
  });

  it("MUST-FAIL: an automated 'achieved' response is NOT cached (a later human verdict must surface: the source-aware latch)", async () => {
    const cacheable = await cacheCondition();
    expect(cacheable(responseBody([automatedAchieved]))).toBe(false);
    expect(cacheable(responseBody([forgedAchieved, automatedAchieved]))).toBe(false);
  });

  it("MUST-FAIL: a genuine operator-principal verdict response IS cacheable (terminal: the latch burns, it is never re-read)", async () => {
    const cacheable = await cacheCondition();
    expect(cacheable(responseBody([genuineAchieved]))).toBe(true);
    expect(cacheable(responseBody([forgedAchieved, genuineAchieved]))).toBe(true);
  });

  it("CONTROL: a calibration response, an empty response and an unparseable body are not cached", async () => {
    const cacheable = await cacheCondition();
    expect(cacheable(responseBody([calibrationAchieved]))).toBe(false);
    expect(cacheable(responseBody([]))).toBe(false);
    expect(cacheable("not json")).toBe(false);
  });
});

describe("oracle-label read: an ignored newest human row does not hide an older genuine verdict", () => {
  it("MUST-FAIL: forged newest, genuine operator verdict older -> the genuine verdict is acted on; the forged row is counted once", async () => {
    const rec = run("exec-hidden", true);
    const { impl, calls } = stubFetch(() => [forgedAchieved, genuineNotAchieved]);
    const lines = await capture(async () => { await consumeOracleLabel(rec, deps(impl)); await settle(); });
    expect(rec.reached).toBe(false);
    expect(rec.humanGraded).toBe(true);
    expect(rec.humanReachNotes).toBe(genuineNotAchieved.notes);
    expect(rec.learning!.oracleLabelWritten).toBe(true);
    expect(gapWrites(calls)).toHaveLength(1);
    expect(lines.some((l) => l.includes("human label IGNORED: no operator principal") && l.includes("exec-hidden"))).toBe(true);
    expect(lines.some((l) => l.includes("HUMAN reach override"))).toBe(true);
  });

  it("MUST-FAIL: several forged rows newest still do not hide the genuine verdict beneath them", async () => {
    const rec = run("exec-hidden-many", true);
    const forged = Array.from({ length: 5 }, (_, i) => ({ ...forgedNotAchieved, notes: `forged ${i}` }));
    const { impl } = stubFetch(() => [...forged, genuineNotAchieved]);
    await capture(async () => { await consumeOracleLabel(rec, deps(impl)); await settle(); });
    expect(rec.reached).toBe(false);
    expect(rec.humanReachNotes).toBe(genuineNotAchieved.notes);
  });

  it("CONTROL: a genuine operator-principal row newest is acted on as before", async () => {
    const rec = run("exec-genuine-newest", true);
    const { impl, calls } = stubFetch(() => [genuineNotAchieved, forgedAchieved, automatedAchieved]);
    const lines = await capture(async () => { await consumeOracleLabel(rec, deps(impl)); await settle(); });
    expect(rec.reached).toBe(false);
    expect(rec.humanGraded).toBe(true);
    expect(rec.learning!.oracleLabelWritten).toBe(true);
    expect(gapWrites(calls)).toHaveLength(1);
    expect(lines.some((l) => l.includes("IGNORED"))).toBe(false);
  });

  it("CONTROL: forged newest over an automated row -> the automated row is consumed (no override, latch unburned)", async () => {
    const rec = run("exec-forged-over-auto", true);
    const { impl, calls } = stubFetch(() => [forgedNotAchieved, { verdict: "not_achieved", labeler: "deterministic" }]);
    const lines = await capture(async () => { await consumeOracleLabel(rec, deps(impl)); await settle(); });
    expect(rec.reached).toBe(true);
    expect(rec.learning!.oracleLabelWritten).toBe(false);
    expect(gapWrites(calls)).toHaveLength(0);
    expect(lines.some((l) => l.includes("HUMAN reach override"))).toBe(false);
  });

  it("CONTROL: calibration rows newest still do not hide the genuine verdict, and are not acted on", async () => {
    const rec = run("exec-calib", true);
    const { impl } = stubFetch(() => [calibrationAchieved, calibrationAchieved, genuineNotAchieved]);
    await capture(async () => { await consumeOracleLabel(rec, deps(impl)); await settle(); });
    expect(rec.reached).toBe(false);
    expect(rec.humanReachNotes).toBe(genuineNotAchieved.notes);
  });
});
