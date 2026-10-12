// PROTECTED: every verdict-corpus case meets its expectation at this tree.
//
// A `green` case (green when appended) must reproduce `expect` exactly: one test per case, named by its id, so a
// red case's gap names its own falsifier (`bun test test/verdict-corpus/corpus.test.ts -t '<case id>'`). A
// `known_red` / `entry_missing` case is REPORTED, not asserted: it may stay red, and the runner holds credit for
// its own class while it does. No case may be nondeterministic, time out or throw. At least MIN_CASES ran.
//
// Hermetic: in-process, no index.ts import, fetch throws during every replay. This file has no environment
// skip: a runtime it cannot judge fails, naming why.
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fidelityCounts, loadCorpus, replayCase, type CaseResult } from "./runner";

/** The count floor (frozen; it may only rise, never fall: the same constant as chain.test.ts). */
export const MIN_CASES = 138;

const DIR = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(DIR);

describe("verdict corpus: every case meets its expectation", () => {
  test("the corpus loads and its chain verifies (else nothing below is evidence)", () => {
    expect(corpus.errors).toEqual([]);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(MIN_CASES);
  });

  const results: CaseResult[] = [];
  for (const c of corpus.cases) {
    test(c.id, () => {
      const r = replayCase(c);
      results.push(r);
      expect([c.id, r.outcome === "nondeterministic" || r.outcome === "timeout" || r.outcome === "error" ? r.diffs : []]).toEqual([c.id, []]);
      if (c.status_at_append === "green") expect([c.id, r.outcome, r.diffs]).toEqual([c.id, "green", []]);
      else if (r.outcome !== "green") console.log(`[verdict-corpus] ${c.status_at_append.toUpperCase()} ${c.id} (reported, not asserted): ${r.diffs.join("; ")}`);
      else console.log(`[verdict-corpus] NOW GREEN ${c.id} (appended ${c.status_at_append}; the admission ratchet adds it to the ever-green set)`);
    });
  }

  test("fidelity is stated for every case and reported by count", () => {
    const counts = fidelityCounts(corpus.cases);
    console.log(`[verdict-corpus] fidelity ${JSON.stringify(counts)}`);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(corpus.cases.length);
  });

  test("every case ran (a silent skip is not a pass)", () => {
    expect(results.length).toBe(corpus.cases.length);
    expect(results.length).toBeGreaterThanOrEqual(MIN_CASES);
  });
});

// SCHEMA EVOLUTION: one frozen record per past judge-input schema version must still replay. The schema is
// additive-only; a bump lands with its migration, or this turns red.
describe("frozen records of every past judge-input schema still replay", () => {
  test("schema 1: a reach-gate record", () => {
    const frozen = {
      schema: 1, id: "0000-frozen-schema-1", class: "frozen", entry: "reachGate", credit_class: "walk:mutation-target", edit_site: "", provenance: { source: "operator-ruling", recorded: "2026-10-12", note: "frozen schema-1 record" },
      input: { schema: 1, entry: "reachGate", goal: "File a gap recording that the review stage stalled.", original_targets: ["substrateGap_write"], deliverables: null, targets_seen_by_walk: ["substrateGap_write"], reframed_from: null,
        evidence: { persisted_writes: [], landed: false, produced_shapes: [], post_reach_sink: false, tools_total: 0, tools_ok: 0, grounded_reads: 0, output_impulses: 0, consumed_in_chain: 0 }, surface: "walk", digest_excerpt: null },
      llm: null, ports: {}, expect: { gate: "hollow", reached: false, hollow_class: "write-goal-no-artifact" }, status_at_append: "green", control: false, licenses: null,
    } as unknown as Parameters<typeof replayCase>[0];
    expect(replayCase(frozen)).toMatchObject({ outcome: "green", diffs: [] });
  });
});
