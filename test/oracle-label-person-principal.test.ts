import { describe, it, expect, beforeEach } from "bun:test";
import * as consumer from "../src/oracle-label-consumer";
import { consumeOracleLabel, type OracleLabelRecord } from "../src/oracle-label-consumer";

/**
 * A SIGNED-IN PERSON'S LABEL IS A HUMAN VERDICT.
 *
 * activity-api stamps a human label from a person signed in on a surface (an on-behalf-of token
 * whose caller identity validated as a login session, for that node's label write) with the person:
 * labeled_by_principal { user_id, caller_type: "session", actor_key_id, aud }, and no key id. This
 * consumer acted only on a stamp with a key id and a verdict-scoped key, so a person's verdict was
 * ignored. What these tests hold:
 *   - a person stamp overrides reach, burns the latch and files the disagreement gap;
 *   - a "session" stamp naming no user, and a user stamp of another caller kind, stay ignored;
 *   - controls: a read/write key stamp stays ignored; a verdict-scoped key stamp still overrides.
 * Fixture rows only, served by a stub fetch.
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

const base = { verdict: "not_achieved", labeler: "human", notes: "person: the gap list is missing" };
const personStamp = { user_id: "person-1", caller_type: "session", actor_key_id: "key-surface", aud: "node-a/goal_verification_label_write", auth_type: "jwt", scopes: ["read", "write"] };
const humanPerson = { ...base, labeled_by_principal: personStamp };
const sessionNoUser = { ...base, labeled_by_principal: { ...personStamp, user_id: "" } };
const userOfKeyCaller = { ...base, labeled_by_principal: { ...personStamp, caller_type: "api_key" } };
const humanFleetKey = { ...base, labeled_by_principal: { key_id: "key-fleet", auth_type: "apikey", scopes: ["read", "write"] } };
const humanVerdictKey = { ...base, labeled_by_principal: { key_id: "key-verdict", auth_type: "apikey", scopes: ["read", "write", "verdict:human"] } };

beforeEach(() => {
  consumer.__resetOracleLabelCountersForTests();
});

describe("oracle-label consumer: a signed-in person is a human-verdict principal", () => {
  it("MUST-FAIL: a person-stamped human row overrides reach, burns the latch and files the disagreement gap", async () => {
    const rec = run("exec-person", true);
    const { impl, calls } = stubFetch([humanPerson]);
    const lines = await capture(async () => { await consumeOracleLabel(rec, deps(impl)); await settle(); });
    expect(rec.reached).toBe(false);
    expect(rec.humanGraded).toBe(true);
    expect(rec.learning!.oracleLabelWritten).toBe(true);
    expect(rec.goalReachReason).toContain("[human override:");
    expect(gapWrites(calls)).toHaveLength(1);
    expect(lines.some((l) => l.includes("IGNORED"))).toBe(false);
    expect(consumer.hasHumanVerdictPrincipal(humanPerson)).toBe(true);
  });

  for (const [name, row] of [["a session stamp naming no user", sessionNoUser], ["a user stamp from a key caller", userOfKeyCaller], ["a read/write key stamp", humanFleetKey]] as const) {
    it(`CONTROL: a human row with ${name} is IGNORED: no override, no latch, no gap`, async () => {
      const rec = run(`exec-ignored-${name.length}`, true);
      const before = JSON.parse(JSON.stringify(rec));
      const { impl, calls } = stubFetch([row]);
      const lines = await capture(async () => { await consumeOracleLabel(rec, deps(impl)); await settle(); });
      expect(rec).toEqual(before);
      expect(gapWrites(calls)).toHaveLength(0);
      expect(lines.some((l) => l.includes("[oracle-label] human label IGNORED"))).toBe(true);
    });
  }

  it("CONTROL: a verdict-scoped key stamp is unchanged by this (still a human-verdict principal)", async () => {
    expect(consumer.hasHumanVerdictPrincipal(humanVerdictKey)).toBe(true);
    expect(consumer.hasHumanVerdictPrincipal(humanFleetKey)).toBe(false);
  });
});
