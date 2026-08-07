import { describe, expect, it } from "bun:test";

import { countsSomeOtherUnit } from "./counts-other-unit";

describe("countsSomeOtherUnit — one rule for the builder AND the oracle", () => {
  it("claims the cold families a file count cannot answer", () => {
    expect(countsSomeOtherUnit("How many distinct file extensions appear under repos/concept-db/src?")).toBe(true);
    expect(countsSomeOtherUnit("How many subdirectories are there under repos/activity-api/src?")).toBe(true);
    expect(countsSomeOtherUnit("How many exports does repos/x/src declare?")).toBe(true);
  });

  it("OBSERVED: the builder's own gate matches 'file' inside 'file extensions'", () => {
    // This is why the builder fired at all. \bfiles?\b matches the FILE in "file extensions",
    // so the goal took the deterministic branch, which pre-empts reuse and rebind, and emitted
    // a plain find|wc -l — every round, identically.
    const g = "How many distinct file extensions appear under repos/concept-db/src?";
    expect(/\bfiles?\b/i.test(g)).toBe(true);
    expect(countsSomeOtherUnit(g)).toBe(true);
  });

  it("leaves genuine file counts alone — the builder must still own those", () => {
    expect(countsSomeOtherUnit("How many TypeScript modules are under repos/discovery-vessel/src?")).toBe(false);
    expect(countsSomeOtherUnit("How many files are under repos/x/src?")).toBe(false);
    expect(countsSomeOtherUnit("What is the combined number of TypeScript modules across repos/a/src and repos/b/src?")).toBe(false);
  });
});
