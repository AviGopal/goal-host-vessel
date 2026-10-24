// THE VERDICT-DIFF GOLDEN CARRIES NO EXECUTION ID IN AN IDEMPOTENCY-KEY HEADER.
//
// The hermetic child (test/judge-split/verdict-diff/child.ts) records every outbound request's headers by value. An
// Idempotency-Key header carries the execution id it dedupes (walk-satisfier-<n>-<virtual ms>), so the golden held 42
// to 45 long id-shaped `"idempotency-key": "…"` values that gitleaks' generic-api-key rule reads as keys. The child now
// records the header as an ordinal placeholder in order of first use (idem-1, idem-2, …), which keeps what the replay
// compares (whether two requests share a key) and drops the id text. Both sides of a check come from the same child.
//
// Pinned on the source here; the golden's own content is pinned beside it once the golden is regenerated.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CHILD = readFileSync(join(import.meta.dir, "judge-split", "verdict-diff", "child.ts"), "utf8");

describe("MUST-FAIL: the child records an Idempotency-Key header as an ordinal placeholder", () => {
  test("the header goes through idemPlaceholder, and the placeholder is idem-<first-use ordinal>", () => {
    expect(CHILD.includes('hdrs[k] = k === "idempotency-key" ? idemPlaceholder(v) : scrub(v);')).toBe(true);
    expect(CHILD.includes("if (!p) { p = `idem-${idemOrdinals.size + 1}`; idemOrdinals.set(v, p); }")).toBe(true);
  });
});

describe("CONTROL: every other header, and Authorization, are recorded as before", () => {
  test("other headers by scrubbed value; Content-Type and Authorization not by value", () => {
    expect(CHILD.includes('if (k !== "content-type" && k !== "authorization") hdrs[k] =')).toBe(true);
    expect(CHILD.includes("auth: headers.has(\"authorization\"),")).toBe(true);
  });
});
