import { describe, it, expect } from "bun:test";
import { multiQuantityNote, pathsNamedIn } from "../src/multi-quantity";

// THE MEASURED FLOOR FAILURE (2026-08-17).
//
// "Count the .ts files directly inside /vessels/goal-host-vessel/src, then count the .ts files
// directly inside /vessels/ribosome-vessel/src, then report the SUM" — truth 57 + 2 = 59.
// The walk ran `find /vessels/goal-host-vessel/src … | wc -l`, produced ONE operand, was
// correctly graded hollow, and then SUPPRESSED the shell satisfier and widened targets — into
// webSearchResult, which died on credits. The right producer was abandoned because its
// argument was incomplete.
//
// These pin the computed fact, not a phrasing. The note must fire on the goal that failed and
// must NOT fire on single-quantity goals, because a note on every goal is noise and noise is
// how a supplied fact degrades into an ignored instruction.

describe("pathsNamedIn", () => {
  it("finds both paths in the measured goal", () => {
    const goal =
      "Count the .ts files directly inside /vessels/goal-host-vessel/src, then count the .ts files directly inside /vessels/ribosome-vessel/src, then report the SUM of those two counts as a single number.";
    expect(pathsNamedIn(goal)).toEqual([
      "/vessels/goal-host-vessel/src",
      "/vessels/ribosome-vessel/src",
    ]);
  });

  it("dedupes a path named twice — one path is one quantity", () => {
    expect(pathsNamedIn("count files in repos/foo/src then list repos/foo/src again")).toEqual([
      "repos/foo/src",
    ]);
  });

  it("strips trailing punctuation so a path in a clause is still one path", () => {
    expect(pathsNamedIn("look at /vessels/a/src, then /vessels/b/src.")).toEqual([
      "/vessels/a/src",
      "/vessels/b/src",
    ]);
  });
});

describe("multiQuantityNote", () => {
  it("THE REGRESSION: fires on the goal that produced one operand and stopped", () => {
    const goal =
      "Count the .ts files directly inside /vessels/goal-host-vessel/src, then count the .ts files directly inside /vessels/ribosome-vessel/src, then report the SUM of those two counts as a single number.";
    const note = multiQuantityNote(goal)!;
    expect(note).not.toBeNull();
    // It must name BOTH paths — the whole point is that the executor sees the operand it
    // omitted, not a general exhortation to be thorough.
    expect(note).toContain("/vessels/goal-host-vessel/src");
    expect(note).toContain("/vessels/ribosome-vessel/src");
    // And must say the answer is the combination, since the measured failure returned an input.
    expect(note).toMatch(/COMBINED|combined result/);
  });

  it("stays silent on a single-path goal — no note is the default", () => {
    expect(multiQuantityNote("Count the .ts files in /vessels/goal-host-vessel/src")).toBeNull();
    expect(multiQuantityNote("How many shapes does the registry advertise?")).toBeNull();
  });

  it("fires on two counted entities with no path named", () => {
    const note = multiQuantityNote(
      "Report the total of the number of shapes and the number of vessels in the registry",
    );
    expect(note).not.toBeNull();
    expect(note).toContain("2 separate quantities");
  });

  it("two paths without a combinator still says each must be covered", () => {
    const note = multiQuantityNote("Show the newest file in /vessels/a/src and in /vessels/b/src")!;
    expect(note).toContain("Each named path must be covered");
  });

  it("states a FACT, never an instruction to try harder", () => {
    // The distinction this module exists for: supplied facts have a 3/3 record on this
    // substrate, added instructions 0/7. A note that drifts into exhortation is the failure.
    const note = multiQuantityNote("sum the files in /vessels/a/src and /vessels/b/src")!;
    expect(note).toMatch(/^STRUCTURAL FACT/);
    expect(note).not.toMatch(/\b(please|make sure|be thorough|remember to|carefully)\b/i);
  });
});
