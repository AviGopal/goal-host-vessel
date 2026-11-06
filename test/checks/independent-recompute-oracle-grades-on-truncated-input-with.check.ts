/**
 * INDEPENDENT-RECOMPUTE ORACLE GRADES ON TRUNCATED INPUT WITH A VERDICT INSTEAD OF ABSTAINING.
 *
 * Reach verdicts leave the walk through the reach spool: a verdict is appended to REACH_SPOOL_PATH
 * and drained into the reached-command store by drainReachSpool(). The independent-recompute oracle
 * re-reads that store and grades whatever rows it finds there.
 *
 * The verdict-delivery site in src/index.ts fires the drain and forgets it:
 *
 *     void drainReachSpool();
 *
 * The delivery path therefore returns while the spool is still being read, and the oracle's re-read
 * of the store is TRUNCATED - it grades the partial row set the drain has managed to place so far as
 * if it were the whole record set. Awaiting the drain at that site is what makes the store complete
 * when delivery returns.
 *
 * This check reads the live module source and asserts the shipped call site itself: no `void
 * drainReachSpool(...)` may remain, and the drain must be awaited where verdicts are delivered. It is
 * red today on the forgotten promise, and green once that call is awaited. A mention of the phrase in
 * a comment is not a call, so comments are stripped before the call sites are examined.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as mod from "../../src/index";

const INDEX_SOURCE = new URL("../../src/index.ts", import.meta.url);
const FIRE_AND_FORGET = /(^|[^\w.$])void\s+drainReachSpool\s*\(/m;
const AWAITED_CALL = /await\s+drainReachSpool\s*\(/;
const ANY_CALL = /drainReachSpool\s*\(/;

/** The module's source as shipped. */
function indexSource(): string {
  return readFileSync(INDEX_SOURCE, "utf8");
}

/** The module's code with line comments and block-comment bodies removed (prose is not a call). */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\*/.test(line))
    .join("\n");
}

describe("the reach-spool drain is awaited, so the oracle never grades a truncated spool read", () => {
  it("still delivers verdicts through the spool (drainReachSpool is invoked)", () => {
    expect(ANY_CALL.test(codeOnly(indexSource()))).toBe(true);
  });

  it("does not fire drainReachSpool as a forgotten promise at the verdict-delivery site", () => {
    expect(FIRE_AND_FORGET.test(codeOnly(indexSource()))).toBe(false);
  });

  it("awaits drainReachSpool, so the store the oracle re-reads is complete when delivery returns", () => {
    expect(AWAITED_CALL.test(codeOnly(indexSource()))).toBe(true);
  });
});
