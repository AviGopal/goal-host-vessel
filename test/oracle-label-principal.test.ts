import { describe, it, expect, beforeEach } from "bun:test";
import * as consumer from "../src/oracle-label-consumer";
import { consumeOracleLabel, type OracleLabelRecord } from "../src/oracle-label-consumer";

/**
 * A "HUMAN" LABEL IS A HUMAN VERDICT ONLY WITH A HUMAN-VERDICT PRINCIPAL.
 *
 * activity-api used to store whatever labeler the caller sent, so a goal walk using goal-host's
 * fleet key could write labeler:"human" and this consumer would override record.reached, burn the
 * latch and file a human_reported disagreement gap. activity-api now stamps a human row with the
 * validated credential (labeled_by_principal); this consumer acts on a human row only when that
 * stamp carries "verdict:human" (or "admin", interim). Fixture rows only, served by a stub fetch.
 */

const ACT = "http://act.test";
const DEV = "http://dev.test";
type Call = { url: string; body: any };

function stubFetch(rows: unknown[]) {
  const calls: Call[] = [];
  const impl = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith(ACT)) return new Response(JSON.stringify({ success: true, content: JSON.stringify(rows) }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
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

const humanNoPrincipal = { verdict: "not_achieved", labeler: "human", notes: "forged: the walk says it failed" };
const humanFleetPrincipal = { ...humanNoPrincipal, labeled_by_principal: { key_id: "key-fleet", auth_type: "apikey", scopes: ["read", "write"] } };
const humanVerdictPrincipal = { ...humanNoPrincipal, notes: "operator: missing the gap list", labeled_by_principal: { key_id: "key-verdict", auth_type: "apikey", scopes: ["read", "write", "verdict:human"] } };
const humanAdminPrincipal = { ...humanVerdictPrincipal, labeled_by_principal: { key_id: "key-admin", auth_type: "apikey", scopes: ["read", "write", "admin"] } };

const ignoredCount = (): number | undefined => (consumer as Record<string, unknown>)["oracleLabelIgnoredHumanCount"] instanceof Function
  ? ((consumer as Record<string, unknown>)["oracleLabelIgnoredHumanCount"] as () => number)()
  : undefined;

beforeEach(() => {
  const reset = (consumer as Record<string, unknown>)["__resetOracleLabelCountersForTests"];
  if (reset instanceof Function) (reset as () => void)();
});

describe("oracle-label consumer: a human override needs a human-verdict principal", () => {
  for (const [name, row] of [["no principal (every pre-fix row)", humanNoPrincipal], ["a read/write fleet-key principal", humanFleetPrincipal]] as const) {
    it(`MUST-FAIL (c): a human-labeled row with ${name} is IGNORED: no override, no latch, no gap, counted and logged`, async () => {
      const rec = run("walk-satisfier-1-1791608365322", true);
      const before = JSON.parse(JSON.stringify(rec));
      const { impl, calls } = stubFetch([row]);
      const lines = await capture(async () => { await consumeOracleLabel(rec, deps(impl)); await settle(); });
      expect(rec).toEqual(before);
      expect(rec.learning!.oracleLabelWritten).toBe(false);
      expect(gapWrites(calls)).toHaveLength(0);
      expect(lines.some((l) => l.includes("[oracle-label] human label IGNORED: no operator principal") && l.includes("walk-satisfier-1-1791608365322"))).toBe(true);
      expect(lines.some((l) => l.includes("HUMAN reach override"))).toBe(false);
      expect(ignoredCount()).toBe(1);
    });
  }

  it("MUST-FAIL (c): the skip is counted once per execution, not once per poll", async () => {
    const rec = run("exec-poll", true);
    const { impl } = stubFetch([humanNoPrincipal]);
    await capture(async () => {
      for (let i = 0; i < 3; i++) await consumeOracleLabel(rec, deps(impl));
      await settle();
    });
    expect(ignoredCount()).toBe(1);
    expect(rec.reached).toBe(true);
  });

  for (const [name, row, key] of [["verdict:human", humanVerdictPrincipal, "key-verdict"], ["admin (interim)", humanAdminPrincipal, "key-admin"]] as const) {
    it(`CONTROL (c): a human row stamped with a ${name} principal overrides, burns the latch and files the disagreement gap`, async () => {
      const rec = run(`exec-${key}`, true);
      const { impl, calls } = stubFetch([row]);
      const lines = await capture(async () => { await consumeOracleLabel(rec, deps(impl)); await settle(); });
      expect(rec.reached).toBe(false);
      expect(rec.humanGraded).toBe(true);
      expect(rec.learning!.oracleLabelWritten).toBe(true);
      expect(rec.goalReachReason).toContain("[human override:");
      expect(gapWrites(calls)).toHaveLength(1);
      expect(lines.some((l) => l.includes("IGNORED"))).toBe(false);
    });
  }

  it("CONTROL: a deterministic label is still consumed as an automated verdict (no principal needed, no override)", async () => {
    const rec = run("exec-det", true);
    const { impl, calls } = stubFetch([{ verdict: "not_achieved", labeler: "deterministic" }]);
    const lines = await capture(async () => { await consumeOracleLabel(rec, deps(impl)); await settle(); });
    expect(rec.reached).toBe(true);
    expect(gapWrites(calls)).toHaveLength(0);
    expect(lines.some((l) => l.includes("consumed automated verdict"))).toBe(true);
    expect(lines.some((l) => l.includes("IGNORED"))).toBe(false);
  });
});
