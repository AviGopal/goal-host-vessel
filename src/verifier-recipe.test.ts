import { describe, expect, it } from "bun:test";

import {
  generaliseCommand, goalTreePath, instantiateRecipe, recipeIsLive, type VerifierRecipe,
} from "./verifier-recipe";

const mk = (o: Partial<VerifierRecipe> = {}): VerifierRecipe => ({
  family: "distinct-file-extensions", template: "find /w/{{vessel}}/src -type f | wc -l",
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

describe("generaliseCommand — parameterised on the VESSEL, which is what varies", () => {
  it("generalises a command that used the DEPLOYED path, which is what they actually use", () => {
    // The goal says repos/<vessel>/src; the authored command says
    // /workspace/git/vessels/<vessel>/src. Keying on the goal's literal span minted ZERO
    // recipes across a 48-goal run.
    expect(generaliseCommand(
      'find /workspace/git/vessels/concept-db/src -name "*.ts" | wc -l',
      "repos/concept-db/src",
    )).toBe('find /workspace/git/vessels/{{vessel}}/src -name "*.ts" | wc -l');
  });

  it("round-trips back to the original command", () => {
    const cmd = "find /w/vessels/concept-db/src -type f -name '*.*' | sed 's/.*\\.//' | sort -u | wc -l";
    const t = generaliseCommand(cmd, "repos/concept-db/src")!;
    expect(instantiateRecipe(t, "repos/concept-db/src")).toBe(cmd);
  });

  it("applies the recipe to a DIFFERENT vessel in the same family", () => {
    const t = generaliseCommand("find /w/vessels/concept-db/src -type f | wc -l", "repos/concept-db/src")!;
    expect(instantiateRecipe(t, "repos/boredom-vessel/src")).toBe("find /w/vessels/boredom-vessel/src -type f | wc -l");
  });

  it("refuses when the vessel never reached the command, or reached it twice", () => {
    expect(generaliseCommand("find /w/vessels/other/src | wc -l", "repos/concept-db/src")).toBeNull();
    expect(generaliseCommand("diff /a/concept-db /b/concept-db", "repos/concept-db/src")).toBeNull();
  });

  it("refuses to interpolate anything that is not a plain vessel name", () => {
    const t = "find /w/vessels/{{vessel}}/src | wc -l";
    expect(instantiateRecipe(t, "; rm -rf /")).toBeNull();
    expect(instantiateRecipe(t, "repos/../../etc/src")).toBeNull();
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

