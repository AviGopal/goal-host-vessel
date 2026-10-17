// HELD-OUT: judge consistency's key over the REAL verdict-corpus cases (test/verdict-corpus/cases, read-only), none of
// which were written for this module. For every case's answer: two attempt contexts of the same answer (different
// timestamps, exec ids, case, emphasis, spacing) share one key, and distinct answers keep distinct keys. Then every case
// replays through reconcileVerdict as a first sight followed by an agreeing re-judgement. MUST-FAIL on the parent
// (d124f2f): src/judge/verdict-consistency.ts does not exist.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as vc from "../../src/judge/verdict-consistency";

const CASES = join(import.meta.dir, "..", "verdict-corpus", "cases");
type Case = { id: string; input?: { answer_text?: unknown; digest_excerpt?: unknown; goal?: unknown; evidence?: { produced_shapes?: unknown } }; expect?: { reached?: unknown } };
function loadCases(): Case[] {
  const out: Case[] = [];
  for (const d of readdirSync(CASES)) {
    const dir = join(CASES, d);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as Case);
  }
  return out;
}
const answerOf = (c: Case): string => String(c.input?.answer_text ?? c.input?.digest_excerpt ?? "");
const shapesOf = (c: Case): string[] => (Array.isArray(c.input?.evidence?.produced_shapes) ? (c.input!.evidence!.produced_shapes as unknown[]).map(String) : []);
const contextA = (a: string) => `${a}\n(judged 2026-10-17T09:00:00Z, exec_aa11bb22)`;
const contextB = (a: string) => `  ${a.replace(/\b(\w)/, (m) => m.toUpperCase())}  \n\n(judged 2026-10-18T23:59:59.999Z, exec_ff00ee99)`;

const cases = loadCases().filter((c) => answerOf(c).trim().length > 0);

describe("held-out: the verdict-corpus answers", () => {
  test("the corpus provides held-out answers to test against", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });
  test("[MUST-FAIL] every answer keeps ONE key across two attempt contexts", () => {
    const split = cases.filter((c) => vc.answerDigest(contextA(answerOf(c)), shapesOf(c)) !== vc.answerDigest(contextB(answerOf(c)), shapesOf(c)));
    expect(split.map((c) => c.id)).toEqual([]);
  });
  test("[CONTROL] distinct answers keep distinct keys (no two different held-out answers collide)", () => {
    const byKey = new Map<string, Set<string>>();
    for (const c of cases) {
      const k = vc.answerDigest(answerOf(c), shapesOf(c));
      const norm = vc.normaliseAnswer(answerOf(c));
      byKey.set(k, (byKey.get(k) ?? new Set()).add(norm));
    }
    expect([...byKey.values()].filter((s) => s.size > 1)).toEqual([]);
  });
  test("[MUST-FAIL] each case's recorded verdict, re-judged the same way under another attempt context, is an agreement", async () => {
    const files = new Map<string, string>();
    const store: vc.ConsistencyStoreIO = { read: async (p) => files.get(p) ?? null, write: async (p, b) => { files.set(p, b); }, list: async () => [] };
    const deps: vc.ReconcileDeps = { dir: "/scratch/vc-heldout", store, now: () => new Date("2026-10-17T12:00:00Z"), sample: async () => null };
    const outcomes: string[] = [];
    for (const c of cases) {
      const reached = c.expect?.reached === true;
      const gh = `case-${c.id}`.replace(/[^0-9a-zA-Z_-]/g, "-").slice(0, 64);
      const base = { goalHash: gh, goal: String(c.input?.goal ?? ""), producedShapes: shapesOf(c), verdict: { reached }, k: 3, ttlMs: 604_800_000 };
      await vc.reconcileVerdict({ ...base, answer: contextA(answerOf(c)), digest: vc.answerDigest(contextA(answerOf(c)), shapesOf(c)) }, deps);
      outcomes.push((await vc.reconcileVerdict({ ...base, answer: contextB(answerOf(c)), digest: vc.answerDigest(contextB(answerOf(c)), shapesOf(c)) }, deps)).outcome);
    }
    expect(outcomes.filter((o) => o !== "agree")).toEqual([]);
  });
});
