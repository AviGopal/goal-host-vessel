// Pure exports of index.ts, exercised through the module itself.
//
// WHY THIS FILE EXISTS. `src/index.ts` is 16,362 lines and is the single most frequently
// changed target in the substrate — 144 of 406 uncovered-target mentions across 400 compose
// traces, roughly a third of everything the effect-coverage check reports as untested. The
// vessel has 70 test files and not one of them imports this module, so every change to it
// lands reviewed but never executed, which is precisely the condition the recovery ladder's
// third rung exists to flag.
//
// These are behavioural assertions, not smoke tests: each one fails if the function's
// contract regresses, and the cases chosen are the ones whose absence has bitten this
// codebase before — a diff scanner that mistakes the `+++` header for an added line, and a
// path parser that treats a file as a directory.
// THE IMPORT IS DYNAMIC, AND DELIBERATELY SO. Importing this module runs its top-level
// bootstrap, which constructs an LLM port and throws outright when LLM_VESSEL_ENDPOINT is
// unset. A static import would therefore make this file fail in any environment without
// that variable — and the mitosis cutover runs the suite before landing, so a test that
// fails on a bare checkout would block every future landing for this vessel. Setting a
// default first and importing afterwards keeps the file self-contained: it needs no
// external configuration and cannot wedge the lane.
//
// That the module cannot be imported without side effects is itself the reason none of the
// vessel's other 70 test files import it.
import { describe, expect, test } from "bun:test";

process.env["LLM_VESSEL_ENDPOINT"] ||= "http://127.0.0.1:8220";
const { symbolInAddedLines, parsePathsAndExt, parseThreshold } = await import("../src/index");

describe("symbolInAddedLines", () => {
  test("finds a symbol on an added line", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "+const openGapKnown = false;"].join("\n");
    expect(symbolInAddedLines(diff, "openGapKnown")).toBe(true);
  });

  test("does NOT count the +++ header as an added line", () => {
    // The header starts with '+' too. A scanner that only checks startsWith("+") reports
    // every symbol in the target's own filename as added.
    const diff = ["--- a/openGapKnown.ts", "+++ b/openGapKnown.ts", "@@ -1 +1 @@", "-const x = 1;"].join("\n");
    expect(symbolInAddedLines(diff, "openGapKnown")).toBe(false);
  });

  test("does not count a symbol that only appears on a removed line", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-const gone = 1;", "+const kept = 2;"].join("\n");
    expect(symbolInAddedLines(diff, "gone")).toBe(false);
    expect(symbolInAddedLines(diff, "kept")).toBe(true);
  });

  test("matches whole tokens only, so a longer identifier does not satisfy a shorter one", () => {
    const diff = ["+++ b/x.ts", "+const gapLifecycleScan = 1;"].join("\n");
    expect(symbolInAddedLines(diff, "gap")).toBe(false);
  });

  test("treats regex metacharacters in the symbol as literals", () => {
    const diff = ["+++ b/x.ts", "+const a = obj.field;"].join("\n");
    expect(symbolInAddedLines(diff, "obj.field")).toBe(true);
    expect(symbolInAddedLines(diff, "objXfield")).toBe(false);
  });
});

describe("parsePathsAndExt", () => {
  test("returns the directory when the goal names one", () => {
    const got = parsePathsAndExt("count the modules under repos/goal-host-vessel/src");
    expect(got).not.toBeNull();
    expect(got!.rel).toBe("repos/goal-host-vessel/src");
  });

  test("returns null for a FILE path, which is not a directory to aggregate over", () => {
    expect(parsePathsAndExt("edit repos/goal-host-vessel/src/index.ts")).toBeNull();
  });

  test("returns null when the goal names no repos path at all", () => {
    expect(parsePathsAndExt("summarise yesterday's failures")).toBeNull();
  });

  test("strips trailing punctuation from the path", () => {
    const got = parsePathsAndExt("look at repos/goal-host-vessel/src, then stop");
    expect(got).not.toBeNull();
    expect(got!.rel).toBe("repos/goal-host-vessel/src");
  });
});

describe("parseThreshold", () => {
  const parseOver = parseThreshold("more than");

  test("extracts the directory and the line count together", () => {
    const got = parseOver("how many files in repos/goal-host-vessel/src have more than 400 lines");
    expect(got).not.toBeNull();
    expect(got!.rel).toBe("repos/goal-host-vessel/src");
    expect(got!.n).toBe(400);
  });

  test("returns null when the comparator phrase is absent", () => {
    expect(parseOver("how many files in repos/goal-host-vessel/src are long")).toBeNull();
  });

  test("returns null when no path is present, even with a threshold", () => {
    expect(parseOver("how many files have more than 400 lines")).toBeNull();
  });

  test("accepts the singular 'line' as well as 'lines'", () => {
    expect(parseOver("files in repos/goal-host-vessel/src with more than 1 line")).not.toBeNull();
  });
});
