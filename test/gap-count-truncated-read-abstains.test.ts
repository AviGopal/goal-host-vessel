// A full page of gaps is a truncated read, not a count. fetchGapCategoryCounts read with limit 2000 and the gap oracles
// (total, ratio, aggregate) graded against the page: an open-gap subset question was "verified" by a 2000 in the answer.
// Source-only: importing src/index.ts reads the live dispatch store.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

describe("gap count oracles — a full page abstains", () => {
  test("[MUST-FAIL on base] the read limit is one constant and a full page returns null (fail open)", () => {
    const fn = SRC.indexOf("async function fetchGapCategoryCounts(");
    expect(fn).toBeGreaterThan(0);
    const body = SRC.slice(fn, fn + 1600);
    expect(body).toContain("limit: GAP_COUNT_READ_LIMIT");
    expect(body).toContain("if (gaps.length >= GAP_COUNT_READ_LIMIT) return null;");
    expect(SRC).toContain("const GAP_COUNT_READ_LIMIT = 2000;");
  });
});
