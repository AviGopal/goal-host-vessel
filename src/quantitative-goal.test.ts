import { describe, expect, it } from "bun:test";

import { isCountableQuestion, isQuantitativeRepoQuestion } from "./quantitative-goal";

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

describe("isQuantitativeRepoQuestion — compositional goals are NOT refused", () => {
  it("OBSERVED LIVE: a count-and-record goal has its own delivery signal", () => {
    // Shipping the refusal without this exclusion dropped the warm families from ~90%
    // reached AND correct to 33%/33%: count_single and lines_single kept working while
    // count_artifact, compare_* and combined all missed, because each ends with
    // "...record it as a durable note titled X". Several oracles decline compositional
    // goals by design, so the refusal inherited every one of them.
    expect(isQuantitativeRepoQuestion("Count the TypeScript modules under repos/obsidian-vessel/src and record the result in a durable note titled harness-b0-g1.")).toBe(false);
    expect(isQuantitativeRepoQuestion("Which has more TypeScript modules, repos/a/src or repos/b/src, and by how many? Record it as a durable note titled cmp.")).toBe(false);
    expect(isQuantitativeRepoQuestion("What is the combined number of TypeScript modules across repos/a/src and repos/b/src? Record it as a durable note titled tot.")).toBe(false);
  });

  it("still refuses the PURE question form of the same families", () => {
    expect(isQuantitativeRepoQuestion("How many subdirectories are there under repos/activity-api/src?")).toBe(true);
    expect(isQuantitativeRepoQuestion("How many distinct file extensions appear under repos/concept-db/src?")).toBe(true);
  });

  it("needs BOTH halves of the artifact ask, so a bare verb does not disable the refusal", () => {
    // "record" alone with no durable noun is not an artifact request.
    expect(isQuantitativeRepoQuestion("How many subdirectories are under repos/x/src? Record the number.")).toBe(true);
  });
});

/**
 * The recompute oracle is gated on this predicate rather than on the repo-tree one, because
 * measuring needs no per-domain calibration. The two domains that scored 0/15 are the test:
 * git goals carry a repos/ path and were REFUSED; registry goals carry none, so nothing
 * observed their failure at all.
 */
describe("isCountableQuestion — domain-independent, which is the point", () => {
  it("claims the two domains that scored 0/15", () => {
    expect(isCountableQuestion("How many commits have landed in repos/concept-db in the last 30 days?")).toBe(true);
    expect(isCountableQuestion("How many distinct shapes does the discovery registry advertise?")).toBe(true);
  });

  it("claims repo-tree questions too — it is a superset, not a sibling", () => {
    expect(isCountableQuestion("How many distinct file extensions appear under repos/concept-db/src?")).toBe(true);
    expect(isQuantitativeRepoQuestion("How many distinct file extensions appear under repos/concept-db/src?")).toBe(true);
  });

  it("still declines what has no measurable answer to recompute", () => {
    expect(isCountableQuestion("Summarise the purpose of repos/discovery-vessel based on its README.")).toBe(false);
    expect(isCountableQuestion("In repos/goal-host-vessel/src/index.ts, replace the sink resolution")).toBe(false);
    expect(isCountableQuestion("Record a note about repos/boredom-vessel/src")).toBe(false);
  });

  it("keeps claiming a count-and-record goal, which the REFUSAL must not", () => {
    // The refusal excludes these because several oracles decline compositional goals by
    // design, so it would inherit them all (measured: warm families 90% -> 33%). Recompute
    // has no such problem — it grades the number, and abstains when none was stated.
    const g = "Count the TypeScript modules under repos/obsidian-vessel/src and record the result in a durable note titled harness-b0-g1.";
    expect(isCountableQuestion(g)).toBe(true);
    expect(isQuantitativeRepoQuestion(g)).toBe(false);
  });
});

describe("isCountableQuestion — a creation goal is NOT a countable question", () => {
  // MEASURED LIVE (dispatch f14c4b94): the recompute oracle graded a CREATION goal reached:true
  // on `find|wc -l`=0 — a count of 0 is proof the file does NOT exist, i.e. the goal FAILED,
  // yet two authors agreed on 0 and it was persisted as a reach (crediting the fallback arm,
  // recording a reusable reached goal-path). A false reach in the β-pump class. A goal whose
  // deliverable is a new file/module must fall to a grader that checks EXISTENCE, not a count.
  it("THE FIX: the verbatim goal that false-reached is no longer countable", () => {
    const g = "Create the new file repos/development-vessel/src/seed/detect-calibration-drift.ts. It should define and export a single-task detector template, modeled on the existing detect-* seed detector templates in that same directory, whose task queries the activity-api endpoint /v2/activities/execution-traces/decision-calibration and yields a report identifying any activity arm whose calibration_error is high with a sufficient number of decisions (posterior-mean predicted success far from actual reach rate). Follow the established detector template shape used by its siblings so it is selectable and graded like they are.";
    expect(isCountableQuestion(g)).toBe(false);
  });

  it("excludes create/write/author of a file, a new artifact, or a single-file repos path", () => {
    expect(isCountableQuestion("Create repos/dev/src/seed/detect-x.ts with a detector that counts the number of arms")).toBe(false);
    expect(isCountableQuestion("author a new detector template with the total number of miscalibrated arms")).toBe(false);
    expect(isCountableQuestion("write a file listing how many resolvers exist")).toBe(false);
  });

  it("MATCHES THE ASK, NOT THE VOCABULARY: legit countables with a creation verb stay countable", () => {
    // Over-exclusion here only drops to the LLM judge (not the refusal gate), but a report is a
    // prose deliverable, not a file — its count is still recompute-gradable. "write a FILE" is
    // excluded; "write a REPORT on how many" is not.
    expect(isCountableQuestion("write a report on how many resolvers exist")).toBe(true);
    expect(isCountableQuestion("how many files were created this week")).toBe(true);
    expect(isCountableQuestion("How many files are under repos/x/src")).toBe(true);
  });
});
