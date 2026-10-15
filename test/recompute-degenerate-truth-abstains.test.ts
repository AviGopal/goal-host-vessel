// A degenerate recompute truth (numeric <= 0, or an empty/"null"-like token) is not a verdict. The 08-07 rule kept it out
// of donation and mint; grading still certified it ("independently recomputed 0 by TWO agreeing derivations"), so two
// git/file proxies agreeing on nothing became reached. Source-only: importing src/index.ts reads the live dispatch store.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

describe("recompute — a degenerate truth abstains", () => {
  test("[MUST-FAIL on base] the verdict honours the same predicate as donation and mint, and abstains before grading", () => {
    const guard = SRC.indexOf("if (!_truthIsMintable) {");
    const mintable = SRC.indexOf("const _truthIsMintable = isToken");
    const grade = SRC.indexOf("const verdict = isToken\n    ? gradeTokenRecompute(truth as string, emitted as string[])");
    expect(mintable).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(mintable);
    expect(grade).toBeGreaterThan(guard);
    const block = SRC.slice(guard, guard + 400);
    expect(block).toContain("abstaining (the judge grades)");
    expect(block).toContain("return null;");
  });
  test("the mint/donation predicate itself is unchanged: numeric truth must be > 0", () => {
    expect(SRC).toContain(": (typeof truth === \"number\" && truth > 0);");
  });
});
