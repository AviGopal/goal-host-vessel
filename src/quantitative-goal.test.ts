import { describe, expect, it } from "bun:test";

import { isQuantitativeRepoQuestion } from "./quantitative-goal";

/**
 * This predicate decides when the reach gate REFUSES to guess. A false positive suppresses a
 * genuine reach (prose/edit goals have no deterministic answer to withhold); a false negative
 * lets the LLM judge keep rubber-stamping a countable question it cannot check, which
 * measured 68% hollow.
 */
describe("isQuantitativeRepoQuestion — the shape an oracle could check", () => {
  it("matches the cold families that measured 0-35% correct at 90% reach", () => {
    expect(isQuantitativeRepoQuestion("How many subdirectories are there under repos/activity-api/src?")).toBe(true);
    expect(isQuantitativeRepoQuestion("How many distinct file extensions appear under repos/concept-db/src?")).toBe(true);
    expect(isQuantitativeRepoQuestion("Which TypeScript module under repos/ribosome-vessel/src has the most lines? Give its filename.")).toBe(true);
    expect(isQuantitativeRepoQuestion("How many TypeScript modules under repos/obsidian-vessel/src contain the text async?")).toBe(true);
  });

  it("matches the warm families too, which is fine — an oracle claims those first", () => {
    expect(isQuantitativeRepoQuestion("How many TypeScript modules are under repos/discovery-vessel/src?")).toBe(true);
    expect(isQuantitativeRepoQuestion("What is the combined number of TypeScript modules across repos/a/src and repos/b/src?")).toBe(true);
  });

  it("does NOT match prose goals, whose right grader is the LLM judge", () => {
    expect(isQuantitativeRepoQuestion("Summarise the purpose of repos/discovery-vessel based on its README.")).toBe(false);
    expect(isQuantitativeRepoQuestion("Explain what repos/ribosome-vessel does.")).toBe(false);
    // A prose goal that happens to contain a superlative must still be excluded.
    expect(isQuantitativeRepoQuestion("Describe the most important part of repos/concept-db/src")).toBe(false);
  });

  it("does NOT match edit goals, which have their own landing evidence", () => {
    expect(isQuantitativeRepoQuestion("In repos/goal-host-vessel/src/index.ts, fix the sink resolution")).toBe(false);
    expect(isQuantitativeRepoQuestion("Add a guard to repos/activity-api/src covering the most common case")).toBe(false);
  });

  it("requires a repos/ tree, not a single file and not nothing", () => {
    expect(isQuantitativeRepoQuestion("How many files are in the vault?")).toBe(false);
    expect(isQuantitativeRepoQuestion("How many lines are in repos/x/src/index.ts?")).toBe(false);
  });

  it("requires an actual question, not a mere mention of a tree", () => {
    expect(isQuantitativeRepoQuestion("Record a note about repos/boredom-vessel/src")).toBe(false);
    expect(isQuantitativeRepoQuestion("repos/activity-api/src")).toBe(false);
  });
});
