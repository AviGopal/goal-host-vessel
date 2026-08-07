import { describe, expect, it } from "bun:test";

import {
  generaliseCommand, goalTreePath, instantiateRecipe, recipeIsLive, type VerifierRecipe,
} from "./verifier-recipe";

const mk = (o: Partial<VerifierRecipe> = {}): VerifierRecipe => ({
  family: "distinct-file-extensions", template: "find {{tree}} -type f | wc -l",
  originGoal: "g", originValue: 2, agreed: 0, disagreed: 0, ...o,
});

describe("goalTreePath — one tree, or nothing", () => {
  it("takes the single tree a countable goal names", () => {
    expect(goalTreePath("How many distinct file extensions appear under repos/concept-db/src?"))
      .toBe("repos/concept-db/src");
  });

  it("refuses the chain form, which one command cannot answer", () => {
    // Two trees is the shape that produced 8 hollow greens from the aggregate oracle.
    expect(goalTreePath("Between repos/a/src and repos/b/src, whichever has more modules, report its lines"))
      .toBeNull();
  });

  it("refuses a file path and a goal with no tree at all", () => {
    expect(goalTreePath("How many lines are in repos/x/src/index.ts?")).toBeNull();
    expect(goalTreePath("How many shapes does the registry advertise?")).toBeNull();
  });
});

describe("generaliseCommand — literal, because a wrong substitution is the worst error here", () => {
  it("turns a one-vessel measurement into a family recipe", () => {
    const t = generaliseCommand("find /w/repos/concept-db/src -type f | wc -l", "repos/concept-db/src");
    expect(t).toBe("find /w/{{tree}} -type f | wc -l");
  });

  it("round-trips: instantiate(generalise(c)) is c", () => {
    const cmd = "find /w/repos/concept-db/src -type f -name '*.*' | sed 's/.*\\.//' | sort -u | wc -l";
    const t = generaliseCommand(cmd, "repos/concept-db/src")!;
    expect(instantiateRecipe(t, "repos/concept-db/src")).toBe(cmd);
  });

  it("refuses when the path never reached the command, or reached it twice", () => {
    // No causal proof the path is what flowed into the measurement.
    expect(generaliseCommand("find /vessels/other -type f | wc -l", "repos/concept-db/src")).toBeNull();
    // Ambiguous: substituting one of two occurrences silently changes meaning.
    expect(generaliseCommand("diff /w/repos/a/src /w/repos/a/src", "repos/a/src")).toBeNull();
  });
});

describe("instantiateRecipe — never interpolate an unvetted span", () => {
  it("binds a well-formed tree path", () => {
    expect(instantiateRecipe("find {{tree}} | wc -l", "repos/x/src")).toBe("find repos/x/src | wc -l");
  });

  it("refuses anything that is not a repos tree, and a template with no slot", () => {
    expect(instantiateRecipe("find {{tree}} | wc -l", "; rm -rf /")).toBeNull();
    expect(instantiateRecipe("find {{tree}} | wc -l", "../../etc")).toBeNull();
    expect(instantiateRecipe("find /fixed | wc -l", "repos/x/src")).toBeNull();
  });
});

describe("recipeIsLive — a verifier is evidence, not authority", () => {
  it("uses a recipe that has never been contradicted", () => {
    expect(recipeIsLive(mk())).toBe(true);
    expect(recipeIsLive(mk({ agreed: 5 }))).toBe(true);
  });

  it("retires one that keeps disagreeing, unforgivingly", () => {
    // A wrong recipe produces wrong ground truth for the WHOLE family, and wrong ground truth
    // returns `disagree`, which carries beta. That is the 25/48 -> 18/48 failure.
    expect(recipeIsLive(mk({ agreed: 0, disagreed: 2 }))).toBe(false);
    expect(recipeIsLive(mk({ agreed: 3, disagreed: 2 }))).toBe(false);
    expect(recipeIsLive(mk({ agreed: 5, disagreed: 2 }))).toBe(true);
  });
});
