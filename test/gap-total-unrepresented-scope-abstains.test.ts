// The gap-total oracle represents only status (open/closed). A goal that adds scope it cannot represent ("filed by goal
// deficiency recognition") must abstain, not be graded as a plain total. The guard is the scope itself (any content
// word left after removing what the parse represents), not the observed phrase. Source-only: the represented-word set
// is read from src/index.ts, so this test cannot drift from it; importing index.ts reads the live dispatch store.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
const setSrc = SRC.match(/const GAP_TOTAL_REPRESENTED = new Set\(\[([\s\S]*?)\]\);/);
const REPRESENTED = new Set(setSrc ? [...setSrc[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : []);
const residual = (goal: string) => goal.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((w) => w && !REPRESENTED.has(w));

describe("gap-total oracle — unrepresented scope abstains", () => {
  test("[MUST-FAIL on base] the parse abstains on any residual content word", () => {
    expect(setSrc).not.toBeNull();
    const fn = SRC.indexOf("function parseGapTotalCount(goal: string)");
    expect(fn).toBeGreaterThan(0);
    const body = SRC.slice(fn, fn + 900);
    expect(body).toContain("if (residual.length > 0) return null;");
  });
  test("the observed subset question abstains; plain totals are still claimed", () => {
    expect(residual("How many open gaps were filed by goal deficiency recognition?")).toEqual(["were", "filed", "by", "goal", "deficiency", "recognition"]);
    expect(residual("How many open gaps are there?")).toEqual([]);
    expect(residual("How many closed substrate gaps are there right now?")).toEqual([]);
    expect(residual("What is the total number of open gaps?")).toEqual([]);
    // other unrepresented scope abstains too (the guard is the scope, not the phrase)
    expect(residual("How many open gaps were created today?").length).toBeGreaterThan(0);
    expect(residual("How many open gaps are in the security category?").length).toBeGreaterThan(0);
  });
});
