// Pins the comment-stripping used by the workspace phrase search.
//
// THE DEFECT: `grep -rl` reports a file when the phrase appears ANYWHERE,
// including prose. Because the search runs over the fleet's own source, any file
// QUOTING a goal becomes the unique answer to that goal. Measured three times in
// one session — twice in goal-host-vessel, once in development-vessel's
// vacuous-edit.ts, a file written to catch drafter mistakes which then attracted
// the very goal it documented.
//
// The stripper is duplicated here rather than exported from index.ts, because
// importing index.ts boots an HTTP server. Kept byte-identical on purpose; if it
// changes there it must change here.
import { describe, test, expect } from "bun:test";

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const PHRASE = "execution-path records";

describe("comment stripping — the three live contamination cases", () => {
  test("a block-comment quote is removed", () => {
    const src = `/**\n * A goal about ${PHRASE} was planned here.\n */\nexport const x = 1;`;
    expect(stripComments(src).includes(PHRASE)).toBe(false);
  });

  test("a line-comment quote is removed", () => {
    const src = `export const x = 1; // note: ${PHRASE} showed up here\n`;
    expect(stripComments(src).includes(PHRASE)).toBe(false);
  });

  test("the SAME phrase in real code survives", () => {
    // The file that genuinely implements the thing must still match.
    const src = `const table = "${PHRASE}";`;
    expect(stripComments(src).includes(PHRASE)).toBe(true);
  });

  test("code plus a comment quote still counts as code", () => {
    const src = `// docs mention ${PHRASE}\nconst q = select("${PHRASE}");`;
    expect(stripComments(src).includes(PHRASE)).toBe(true);
  });
});

describe("comment stripping — must not eat real code", () => {
  test("a URL's // is not a comment", () => {
    // The `[^:]` guard exists for exactly this: `https://host/path` must survive.
    const src = `const u = "https://example.com/goal-paths";`;
    expect(stripComments(src)).toContain("https://example.com/goal-paths");
  });

  test("division is untouched", () => {
    expect(stripComments("const r = a / b;")).toContain("a / b");
  });

  test("empty and comment-only input degrade quietly", () => {
    expect(stripComments("")).toBe("");
    expect(stripComments("// only a comment").trim()).toBe("");
  });
});
