// PROTECTED (MUST-FAILS): AN UNREADABLE CORPUS HOLDS EVERY CORPUS-GOVERNED CREDIT CLASS (case C-hollow-3, qa ruling).
//
// The fallback when the runner's status is missing holds the classes of the ever-red cases. That set is DERIVED FROM THE
// CORPUS, so when the corpus itself is unreadable (MANIFEST absent or unreadable, or its hash chain broken) it is empty, and
// "fail closed" held nothing: fail-OPEN on credit. Now an unreadable corpus holds every class of the closed CREDIT_CLASSES,
// in both directions, at both readers (the credit hold and the runner's published status), and the runner files ONE
// idempotent gap at the credit hold whose falsifier is a run that reads the corpus. A readable corpus with no status keeps
// the ever-red-only hold (the control).
// MUST-FAIL under the mutant that restores the ever-red-only hold for an unreadable corpus.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDIT_CLASSES } from "../../src/judge/classes";
import { everRedHolds, loadCorpus } from "../../src/judge/corpus-runner";
import { configureCreditHold, DEPLOYED_CORPUS_DIR, heldFor, holdView, readStatusSync, type VerdictCorpusStatus } from "../../src/judge/credit-hold";
import { runVerdictCorpusActivity, UNREADABLE_CORPUS_SITE, type CorpusGap, type CorpusSinks } from "../../src/judge/corpus-activity";

const HERE = import.meta.dir;
const root = mkdtempSync(join(tmpdir(), "vc-unreadable-"));
afterAll(() => {
  configureCreditHold({ reader: readStatusSync, corpusDir: DEPLOYED_CORPUS_DIR, clock: () => Date.now(), onUnavailable: () => {} });
  rmSync(root, { recursive: true, force: true });
});

const EMPTY = join(root, "empty");
mkdirSync(EMPTY, { recursive: true });
/** A copy of the real corpus whose MANIFEST chain is broken (line 2's prev rewritten). */
const BROKEN = join(root, "broken");
mkdirSync(BROKEN, { recursive: true });
cpSync(join(HERE, "cases"), join(BROKEN, "cases"), { recursive: true });
{
  const lines = readFileSync(join(HERE, "MANIFEST.jsonl"), "utf8").split("\n");
  const m = JSON.parse(lines[1]!) as Record<string, unknown>;
  lines[1] = JSON.stringify({ n: m.n, id: m.id, path: m.path, case_sha256: m.case_sha256, fidelity: m.fidelity, prev: "f".repeat(64), link: m.link });
  writeFileSync(join(BROKEN, "MANIFEST.jsonl"), lines.join("\n"));
}
const ALL = CREDIT_CLASSES.length * 2;
const NOW = Date.parse("2026-10-12T20:00:00Z");
const pairs = (hs: Array<{ credit_class: string; direction: string }>) => new Set(hs.map((h) => `${h.credit_class}|${h.direction}`));

describe("an unreadable corpus holds every governed credit class", () => {
  test("controls: the real corpus is readable and its ever-red hold is NOT every class; the broken copy does not verify", () => {
    const real = loadCorpus(HERE);
    expect(real.ok).toBe(true);
    expect(pairs(everRedHolds(real.cases, null, new Date(NOW).toISOString())).size).toBeLessThan(ALL);
    expect(loadCorpus(BROKEN).ok).toBe(false);
    expect(loadCorpus(EMPTY).ok).toBe(false);
  });

  for (const [name, dir] of [["absent MANIFEST", EMPTY], ["broken MANIFEST chain", BROKEN]] as const) {
    test(`(${name}) holdView with no status holds every class in both directions`, () => {
      const v = holdView(null, NOW, dir);
      expect(v.source).toBe("corpus_unreadable");
      expect(pairs(v.holds).size).toBe(ALL);
      for (const k of CREDIT_CLASSES) for (const d of ["reach", "hollow"]) expect(pairs(v.holds).has(`${k}|${d}`)).toBe(true);
    });
    test(`(${name}) heldFor any governed class is non-null, in both directions`, () => {
      const reasons: string[] = [];
      configureCreditHold({ reader: () => null, corpusDir: dir, clock: () => NOW, everGreen: () => null, onUnavailable: (why) => reasons.push(why) });
      for (const k of CREDIT_CLASSES) {
        expect([k, heldFor([k], "reach", "t") !== null]).toEqual([k, true]);
        expect([k, heldFor([k], "hollow", "t") !== null]).toEqual([k, true]);
      }
      expect(reasons.length).toBe(1); // the missing status is still reported once
    });
  }

  test("a status that says corpus_unreadable holds every class, whatever holds it lists", () => {
    const st = { state: "corpus_unreadable", holds: [], run_at: new Date(NOW).toISOString(), period_s: 3600 };
    const v = holdView(st, NOW, HERE);
    expect(v.source).toBe("corpus_unreadable");
    expect(pairs(v.holds).size).toBe(ALL);
  });

  test("CONTROL: a readable corpus with no status keeps the ever-red-only hold", () => {
    const v = holdView(null, NOW, HERE);
    expect(v.source).toBe("unreadable");
    expect(pairs(v.holds)).toEqual(pairs(everRedHolds(loadCorpus(HERE).cases, null, new Date(NOW).toISOString())));
  });

  test("the runner publishes every class held and files ONE idempotent gap at the credit hold", async () => {
    const statuses: VerdictCorpusStatus[] = [];
    const gaps: CorpusGap[] = [];
    const s: CorpusSinks = {
      readPreviousStatus: async () => null,
      readEverGreen: async () => null,
      readScopeExcluded: async () => ["repos/goal-host-vessel/src/judge/"],
      writeStatus: async (x) => { statuses.push(x); },
      recordReport: async () => {},
      fileGap: async (g) => { gaps.push(g); },
      readGap: async () => null,
    };
    const st = await runVerdictCorpusActivity({ dir: EMPTY, node: "t", deployedSha: null, trigger: "test", nowMs: NOW, sinks: s });
    expect(st.state).toBe("corpus_unreadable");
    expect(pairs(st.holds).size).toBe(ALL);
    expect(statuses.length).toBe(1);
    expect(pairs(statuses[0]!.holds).size).toBe(ALL);
    expect(gaps.map((g) => g.id)).toEqual(["verdict-corpus-runner-failed-t"]);
    expect(UNREADABLE_CORPUS_SITE).toBe("repos/goal-host-vessel/src/judge/credit-hold.ts");
    expect(gaps[0]!.edit_site).toBe(UNREADABLE_CORPUS_SITE);
    expect(gaps[0]!.falsifier).toEqual({ class: "class1", check: "verdict-corpus-run", case_id: null });
  });
});
