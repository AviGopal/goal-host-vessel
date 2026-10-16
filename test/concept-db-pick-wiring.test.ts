// Wiring for concept-db-pick.test.ts: goal-host's conceptDbUrl picks its row with pickConceptDbRow and this
// substrate's own peers, not with the first non-libp2p row. Source-level, so it fails on the old form for that reason.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
const fn = src.slice(src.indexOf("async function conceptDbUrl()"), src.indexOf("async function conceptDbUrl()") + 2500);

describe("[MUST-FAIL] conceptDbUrl orders concept-db rows by reachability", () => {
  test("it uses pickConceptDbRow with the own-substrate set", () => {
    expect(fn).toContain("pickConceptDbRow(");
    expect(fn).toContain("await ownSubstratePeers()");
  });
  test("it no longer takes the first non-libp2p row", () => {
    expect(fn).not.toMatch(/named\.find\(\(x\) => x\?\.\["protocol"\] !== "libp2p"/);
  });
});
