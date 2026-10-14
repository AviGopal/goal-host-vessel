import { describe, it, expect } from "bun:test";
import * as mod from "../../src/missing-verifier-gap";
import { isQuantitativeRepoQuestion } from "../../src/quantitative-goal";

describe("verifierFamilyOf only handles quantitative repo questions", () => {
  it("returns null for non-quantitative goals", () => {
    const nonQuantGoal = "Read the contents of README.md";
    expect(isQuantitativeRepoQuestion(nonQuantGoal)).toBeFalse();
    expect(mod.verifierFamilyOf(nonQuantGoal)).toBeNull();
  });

  it("returns a family name for quantitative goals", () => {
    const quantGoal = "Count the number of functions in src/index.ts";
    expect(isQuantitativeRepoQuestion(quantGoal)).toBeTrue();
    expect(mod.verifierFamilyOf(quantGoal)).toBe("function-count");
  });

  it("returns null for verbatim file-read goals, which are non-quantitative", () => {
    const verbatimGoal = "Read the file content of repos/example-vessel/src/index.ts";
    expect(isQuantitativeRepoQuestion(verbatimGoal)).toBeFalse();
    expect(mod.verifierFamilyOf(verbatimGoal)).toBeNull();
  });
});