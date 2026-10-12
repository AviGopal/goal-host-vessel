// PROTECTED: the credit stop (DESIGN §5.4). A red verdict-corpus case holds learning for its own credit class, in
// its direction, read at use time from the shaped verdictCorpusStatus record: fresh holds apply, a stale status
// keeps its last holds (never green), an unreadable status holds every class any case names (fail closed), and
// every credit site in index.ts consults the hold.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureCreditHold, readStatusSync, heldFor, heldForGoal, holdView, DEPLOYED_CORPUS_DIR, HOLD_CACHE_TTL_MS, STALE_PERIODS } from "../../src/judge/credit-hold";
import { noteClasses } from "../../src/judge/credit-classes";
import { loadCorpus } from "./runner";

const DIR = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(DIR, "..", "..", "src", "index.ts"), "utf8");
const NOW = Date.parse("2026-10-12T12:00:00Z");
const hold = (credit_class: string, direction: "reach" | "hollow") => ({ credit_class, direction, case_ids: ["0001-x"], since: "2026-10-12T00:00:00Z", review_by: "2026-10-15T00:00:00Z" });
const status = (over: Record<string, unknown> = {}) => ({ schema: 1, node: "t", run_at: new Date(NOW - 60_000).toISOString(), period_s: 21600, holds: [hold("floor:zero-tool", "reach")], ...over });

afterAll(() => configureCreditHold({ reader: readStatusSync, corpusDir: DEPLOYED_CORPUS_DIR, clock: () => Date.now() }));

describe("holdView (pure)", () => {
  test("a fresh status: its holds, source status", () => {
    expect(holdView(status(), NOW, DIR)).toEqual({ holds: [hold("floor:zero-tool", "reach")], source: "status" });
  });
  test("MUST-FAIL (stale is never green): a status older than STALE_PERIODS x period keeps its holds, marked stale", () => {
    const v = holdView(status({ run_at: new Date(NOW - (STALE_PERIODS * 21600 + 1) * 1000).toISOString() }), NOW, DIR);
    expect(v.source).toBe("stale");
    expect(v.holds.length).toBe(1);
  });
  test("a fresh status with no holds holds nothing (positive control)", () => {
    expect(holdView(status({ holds: [] }), NOW, DIR)).toEqual({ holds: [], source: "status" });
  });
  test("MUST-FAIL (fail closed): no status holds every class any case names, in its case's direction", () => {
    const v = holdView(null, NOW, DIR);
    expect(v.source).toBe("unreadable");
    const named = new Set(loadCorpus(DIR).cases.map((c) => c.credit_class));
    expect(new Set(v.holds.map((h) => h.credit_class))).toEqual(named);
    for (const h of v.holds) expect(h.review_by).toBe(new Date(Date.parse(h.since) + 72 * 3600 * 1000).toISOString());
  });
  test("a malformed status is unreadable, not empty", () => {
    expect(holdView({ holds: "x" } as never, NOW, DIR).source).toBe("unreadable");
  });
});

describe("heldFor / heldForGoal (use-time reader)", () => {
  test("holds are directional: a reach hold does not stop hollow-direction learning", async () => {
    configureCreditHold({ reader: () => status(), clock: () => NOW });
    expect(heldFor(["floor:zero-tool"], "reach", "t")).toMatchObject({ credit_class: "floor:zero-tool", direction: "reach", source: "status" });
    expect(heldFor(["floor:zero-tool"], "hollow", "t")).toBeNull();
    expect(heldFor(["walk:read-target"], "reach", "t")).toBeNull();
  });
  test("a goal's noted classes are what the credit site asks about", async () => {
    configureCreditHold({ reader: () => status(), clock: () => NOW });
    noteClasses("a goal the floor answered with zero tools", ["floor:zero-tool"]);
    expect(heldForGoal("a goal the floor answered with zero tools", "reach", "t")).not.toBeNull();
    expect(heldForGoal("a goal never judged", "reach", "t")).toBeNull();
  });
  test("the reader is consulted at use time, cached at most HOLD_CACHE_TTL_MS", async () => {
    let calls = 0; let t = NOW;
    configureCreditHold({ reader: () => { calls++; return status(); }, clock: () => t });
    heldFor(["floor:zero-tool"], "reach", "t"); heldFor(["floor:zero-tool"], "reach", "t");
    expect(calls).toBe(1);
    t += HOLD_CACHE_TTL_MS + 1;
    heldFor(["floor:zero-tool"], "reach", "t");
    expect(calls).toBe(2);
  });
  test("a reader that throws is unreadable (fail closed), not open", async () => {
    configureCreditHold({ reader: () => { throw new Error("x"); }, clock: () => NOW, corpusDir: DIR });
    expect(heldFor(["floor:zero-tool"], "reach", "t")).toMatchObject({ source: "unreadable" });
  });
});

/** Each credit site consults the hold inside its own body (anchor = the function head; the guard must follow). */
export const CREDIT_SITES: ReadonlyArray<readonly [string, string]> = [
  ["async function penaliseHollowTemplate(", `creditHold.heldForGoal(goalText, "hollow", "penaliseHollowTemplate")`],
  ["async function creditReachedTemplate(", `creditHold.heldForGoal(goalText, "reach", "creditReachedTemplate")`],
  ["async function recordGoalPath(", `creditHold.heldForGoal(goalText, reached ? "reach" : "hollow", "recordGoalPath")`],
  ["async function mintReachedTrace(", `creditHold.heldForGoal(goalText, "reach", "mintReachedTrace")`],
  ["const _floorShortcut = reachingPathway ? ", `creditHold.heldFor(`],
];
describe("every credit site consults the hold", () => {
  for (const [anchor, guard] of CREDIT_SITES) test(anchor, () => {
    const i = SRC.indexOf(anchor);
    expect([anchor, i >= 0]).toEqual([anchor, true]);
    expect([anchor, SRC.slice(i, i + 2400).includes(guard)]).toEqual([anchor, true]);
  });
  test("the reach-direction credit callers pass the goal, so the hold can see its classes", () => {
    expect(SRC).toContain(`creditReachedTemplate(_stepId, verdict.reason ?? "goal reached", goal)`);
    expect(SRC).toContain(`creditReachedTemplate(selId, verdict.reason ?? "goal reached", goal as string)`);
    expect((SRC.match(/mintReachedTrace\([^\n]*, goal(?: as string)?\);/g) ?? []).length).toBe(3);
  });
  test("MUST-FAIL: a creditReachedTemplate that skips heldFor is red", () => {
    const mutant = SRC.replace(`if (creditHold.heldForGoal(goalText, "reach", "creditReachedTemplate")) return { templateId: activityId, dAlpha: 0, dBeta: 0 };`, "");
    const i = mutant.indexOf("async function creditReachedTemplate(");
    expect(mutant.slice(i, i + 2400).includes(`creditHold.heldForGoal(goalText, "reach", "creditReachedTemplate")`)).toBe(false);
  });
});
