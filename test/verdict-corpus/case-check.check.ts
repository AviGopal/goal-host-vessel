// THE CLASS1 MACHINE CHECK OF EACH RED-CASE GAP (closed). One test per verdict-corpus case, titled exactly the case
// id, that passes only when that case replays green. The runner files each red case's gap with
//   evidence_resolve = {shape: "test_suite", input: {vessel: "repos/goal-host-vessel",
//                       test_file: "test/verdict-corpus/case-check.check.ts", only_tests: ["<case id>"]}}
// so dev-vessel's own check runs THIS file alone and judges only that case's test: the case defines done.
//
// It is a `.check.ts`, never in the gate suite: known-red cases are red here BY DESIGN (the protected
// corpus.test.ts reports them instead). Run it on purpose: bun test ./test/verdict-corpus/case-check.check.ts
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus, replayCase } from "./runner";

const corpus = loadCorpus(dirname(fileURLToPath(import.meta.url)));

describe("verdict-corpus case check", () => {
  test("the corpus loads (else no case check is evidence)", () => { expect(corpus.errors).toEqual([]); });
  for (const c of corpus.cases) test(c.id, () => {
    const r = replayCase(c);
    expect([c.id, r.outcome, r.diffs]).toEqual([c.id, "green", []]);
  });
});
