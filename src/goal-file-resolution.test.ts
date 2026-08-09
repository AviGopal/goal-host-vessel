import { describe, expect, test } from "bun:test";
import {
  resolvePathlessCodeChangeGoal,
  extractSearchTerms,
  isPathlessCodeChangeGoal,
  restateWithTargetFile,
} from "./goal-file-resolution";
import { isEditIntentGoal } from "./goal-intent";

describe("isPathlessCodeChangeGoal", () => {
  // THE TWO GOALS THAT ACTUALLY FAILED (hub dispatches a69c8058 / 72f02fea,
  // 2026-08-09). Both asked for a change, neither landed one, because
  // isEditIntentGoal requires a path they did not carry. These are the
  // regression cases: if either stops being recognised, the gap is back.
  // KNOWN RESIDUAL GAP, asserted so it cannot be mistaken for coverage.
  // This goal names no code target at all — "registry", "addresses",
  // "consumers", "container". Whether the repair is code, config, or a
  // deployment change is not knowable from the text, so a LEXICAL predicate
  // must decline it. Recognising it needs investigate → locate → restate,
  // not a wider regex. Widening CODE_TARGET until this passed would route
  // every runtime-misbehaviour report into feature_compose.
  test("declines a runtime-misbehaviour report with no code target (documented gap)", () => {
    const goal =
      "Federated peers are advertised in the discovery registry with loopback addresses that callers outside the container cannot dial. Fix this so that consumers of the registry resolve an address they can actually reach.";
    expect(isEditIntentGoal(goal)).toBe(false);
    expect(isPathlessCodeChangeGoal(goal)).toBe(false);
  });

  test("recognises the live goal that inferred llm_completion_dispatch", () => {
    const goal =
      "Change the fleet's code so vessels stop publishing unreachable loopback addresses for federated peers. Write and land the code change, do not just describe it.";
    expect(isEditIntentGoal(goal)).toBe(false);
    expect(isPathlessCodeChangeGoal(goal)).toBe(true);
  });

  test("declines a goal that already names a file — it is already routable", () => {
    const goal = "Edit repos/goal-host-vessel/src/index.ts to add a guard";
    expect(isEditIntentGoal(goal)).toBe(true);
    expect(isPathlessCodeChangeGoal(goal)).toBe(false);
  });

  // FALSE POSITIVES ARE THE EXPENSIVE DIRECTION: a report goal routed into
  // feature_compose drafts and commits. Each of these carries a mutation verb.
  test("declines analysis and report asks that merely mention code", () => {
    for (const goal of [
      "Analyze the resolver code and report which functions changed",
      "Explain how the discovery vessel resolves a shape",
      "How many source files in the codebase changed today?",
      "Review the endpoint implementation and list all the guards",
      "Investigate why the parser module fails to update its cache",
    ]) {
      expect(isPathlessCodeChangeGoal(goal)).toBe(false);
    }
  });

  test("declines a change ask with no code target", () => {
    for (const goal of [
      "Fix the gap queue so it stops showing closed gaps",
      "Update my notes with today's findings",
      "Remove the stale entries from the vault",
    ]) {
      expect(isPathlessCodeChangeGoal(goal)).toBe(false);
    }
  });

  // Measured 2026-08-09 by calling this predicate with real operator phrasings.
  // Every one of these is a genuine code-change ask that returned FALSE, so no
  // goal about shell or deploy tooling could reach the edit path at all. The
  // ask is not exotic — "make the deploy fail loudly" is how a person says it.
  test("accepts shell and deploy tooling as a code target", () => {
    for (const goal of [
      "Change the deploy script to verify the commit it actually shipped",
      "Fix the shell script that mirrors vessels into the live container",
      "Update the entrypoint script so it fails when a unit is masked",
    ]) {
      expect(isPathlessCodeChangeGoal(goal)).toBe(true);
    }
  });

  test("accepts 'make X do Y' phrasing — the way an operator states a change", () => {
    // MUTATION_VERB had no `make`, so the single most natural phrasing of a
    // change request was invisible to the edit path.
    expect(
      isPathlessCodeChangeGoal(
        "Make the deploy script fail loudly instead of reporting success when the wrong commit landed",
      ),
    ).toBe(true);
  });

  test("a bare 'count' inside a change ask does not veto it", () => {
    // NOT_A_CHANGE carried \bcount\b for "count the files". It also matched
    // "so scripts count as code", vetoing an unambiguous edit request.
    expect(
      isPathlessCodeChangeGoal("Update the predicate module so shell scripts count as code"),
    ).toBe(true);
  });

  // The vetoes above are the ONLY thing being loosened. These re-assert the
  // properties that widening a predicate normally breaks — the reason the
  // narrow version existed. If a later widening trips one of these, it is the
  // widening that is wrong, not the test.
  test("still declines counting and reporting asks", () => {
    for (const goal of [
      "Count the resolvers in the codebase",
      "How many scripts does the deploy path run?",
      "Report the number of source files that changed",
      "List all the shell scripts in the repo",
    ]) {
      expect(isPathlessCodeChangeGoal(goal)).toBe(false);
    }
  });

  test("still declines prose and data asks that borrow a code word", () => {
    for (const goal of [
      "Update my notes about the deploy script",
      "Add a note describing how the shell script works",
    ]) {
      expect(isPathlessCodeChangeGoal(goal)).toBe(false);
    }
  });
});

describe("extractSearchTerms", () => {
  test("prefers quoted and identifier-shaped tokens over bare words", () => {
    const terms = extractSearchTerms(
      "Fix `isEditIntentGoal` in the goal_host code so target_shapes is set",
    );
    expect(terms).toContain("isEditIntentGoal");
    expect(terms).toContain("goal_host");
    expect(terms).toContain("target_shapes");
    // The quoted symbol is the most specific signal, so it must be searched first.
    expect(terms[0]).toBe("isEditIntentGoal");
  });

  test("picks up vessel names so a repo can be narrowed without a symbol", () => {
    expect(extractSearchTerms("stop discovery-vessel advertising loopback")).toContain(
      "discovery-vessel",
    );
  });

  test("drops sub-3-character noise and never repeats a term", () => {
    const terms = extractSearchTerms("fix isEditIntentGoal and isEditIntentGoal in ts");
    expect(terms.filter((t) => t === "isEditIntentGoal")).toHaveLength(1);
    expect(terms).not.toContain("ts");
  });

  test("returns empty rather than guessing when the goal names nothing", () => {
    expect(extractSearchTerms("fix the code")).toEqual([]);
  });
});

describe("restateWithTargetFile", () => {
  const restated = restateWithTargetFile(
    "Stop publishing loopback addresses.",
    "repos/discovery-vessel/src/index.ts",
  );

  // THE WHOLE POINT: the restated goal must satisfy the predicate that the
  // original failed, or this module has moved the problem instead of fixing it.
  test("produces a goal the existing edit path accepts", () => {
    expect(isEditIntentGoal(restated)).toBe(true);
  });

  test("names the file in the lead sentence, per the edit-intent contract", () => {
    expect(restated.split("\n")[0]).toContain("repos/discovery-vessel/src/index.ts");
  });

  test("preserves the original ask verbatim", () => {
    expect(restated).toContain("Stop publishing loopback addresses.");
  });

  test("marks the target as inferred so a wrong guess stays visible", () => {
    expect(restated.toLowerCase()).toContain("wrong target");
  });
});

describe("resolvePathlessCodeChangeGoal", () => {
  const CHANGE = "Change the fleet's code so the loopbackGuard stops publishing bad addresses.";

  test("restates on a unique hit, and the result routes to the edit path", async () => {
    const out = await resolvePathlessCodeChangeGoal(CHANGE, async () => [
      "repos/discovery-vessel/src/index.ts",
    ]);
    expect(out).toContain("repos/discovery-vessel/src/index.ts");
    expect(isEditIntentGoal(out)).toBe(true);
  });

  // AMBIGUITY IS FAILURE, NOT A RANKING PROBLEM. Two candidates means there is
  // no evidence for choosing, and choosing anyway is the guess this prevents.
  test("leaves the goal unchanged when the term matches several files", async () => {
    const out = await resolvePathlessCodeChangeGoal(CHANGE, async () => [
      "repos/a-vessel/src/index.ts",
      "repos/b-vessel/src/index.ts",
    ]);
    expect(out).toBe(CHANGE);
    expect(isEditIntentGoal(out)).toBe(false);
  });

  test("leaves the goal unchanged when nothing matches", async () => {
    expect(await resolvePathlessCodeChangeGoal(CHANGE, async () => [])).toBe(CHANGE);
  });

  test("a throwing search must not read as 'no such file'", async () => {
    const out = await resolvePathlessCodeChangeGoal(CHANGE, async () => {
      throw new Error("rg exploded");
    });
    expect(out).toBe(CHANGE);
  });

  test("never touches a goal the predicate declined", async () => {
    const report = "Analyze the resolver code and report which functions changed";
    expect(
      await resolvePathlessCodeChangeGoal(report, async () => ["repos/x-vessel/src/i.ts"]),
    ).toBe(report);
  });

  test("tries the next term when the most specific one is ambiguous", async () => {
    // Needs a goal carrying TWO searchable terms — `loopbackGuard` alone gives
    // the resolver nothing to fall back to.
    const twoTerms =
      "Change the fleet's code so the loopbackGuard in discovery-vessel stops publishing bad addresses.";
    expect(extractSearchTerms(twoTerms).length).toBeGreaterThan(1);
    const calls: string[] = [];
    const out = await resolvePathlessCodeChangeGoal(twoTerms, async (term) => {
      calls.push(term);
      return calls.length === 1 ? ["a.ts", "b.ts"] : ["repos/discovery-vessel/src/index.ts"];
    });
    expect(calls.length).toBeGreaterThan(1);
    expect(isEditIntentGoal(out)).toBe(true);
  });

  test("reports what it did through the tap, so the walk log shows it", async () => {
    const taps: string[] = [];
    await resolvePathlessCodeChangeGoal(
      CHANGE,
      async () => ["repos/discovery-vessel/src/index.ts"],
      (m) => taps.push(m),
    );
    expect(taps.join(" ")).toContain("restated with target repos/discovery-vessel/src/index.ts");
  });
});
