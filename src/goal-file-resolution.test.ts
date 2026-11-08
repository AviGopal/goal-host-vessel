import { describe, expect, test } from "bun:test";
import {
  extractSearchTerms,
  isPathlessCodeChangeGoal,
  consensusSymbols,
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

  test("reads repo names that do not end in -vessel", () => {
    // Measured 2026-08-09: two dispatches died with "no unique file" because
    // "the activity api" and "the goal host code" produced only phrases. Five
    // repos in the fleet are not <name>-vessel — activity-api, concept-db,
    // cpg-inference-ts, ias-executor-ts, libp2p-federation-transport — so a
    // -vessel-only rule silently excluded all of them from being nameable.
    expect(extractSearchTerms("Fix the activity api schema code that normalizes timestamps")).toContain(
      "activity-api",
    );
    expect(extractSearchTerms("Update the concept db module that stores prose knowledge")).toContain(
      "concept-db",
    );
  });

  test("recognises a multi-word vessel name without minting fake ones", () => {
    // "the goal host code" means goal-host-vessel. The unguarded version of this
    // rule also produced timestamps-come-vessel, judges-reach-vessel and four
    // more from ordinary prose — each would be searched for, and worse, accepted
    // as a SCOPE, narrowing the search to a directory that cannot exist.
    const terms = extractSearchTerms(
      "Fix the goal host code that judges reach content so a payload carrying stub fields does not count",
    );
    expect(terms).toContain("goal-host-vessel");
    expect(terms.filter((t) => t.endsWith("-vessel"))).toEqual(["goal-host-vessel"]);
  });

  test("reads an unhyphenated vessel name, and ranks it above loose phrases", () => {
    // Measured 2026-08-09: a goal saying "make the discovery vessel prefer a
    // reachable endpoint" resolved onto goal-host-vessel/src/index.ts, because
    // the vessel extractor only matched the hyphenated spelling while the
    // phrase "vessels register" happened to hit one file first. A person writes
    // "the discovery vessel"; naming the vessel is the STRONGEST locating
    // signal in the goal, so it must outrank every phrase.
    const terms = extractSearchTerms(
      "Some vessels register themselves with a loopback address. Make the discovery vessel prefer a reachable endpoint.",
    );
    expect(terms).toContain("discovery-vessel");
    const vesselAt = terms.indexOf("discovery-vessel");
    const firstPhraseAt = terms.findIndex((t) => t.includes(" "));
    expect(firstPhraseAt === -1 || vesselAt < firstPhraseAt).toBe(true);
  });

  test("drops sub-3-character noise and never repeats a term", () => {
    const terms = extractSearchTerms("fix isEditIntentGoal and isEditIntentGoal in ts");
    expect(terms.filter((t) => t === "isEditIntentGoal")).toHaveLength(1);
    expect(terms).not.toContain("ts");
  });

  test("returns empty rather than guessing when the goal names nothing", () => {
    expect(extractSearchTerms("fix the code")).toEqual([]);
  });

  // Measured 2026-08-09: the real blocker after the vocabulary fix. An operator
  // describes a BEHAVIOUR ("the deploy reports success when it shipped the wrong
  // commit") and names no camelCase symbol, so every extractor above returned
  // nothing and the goal was declined for lack of a search term. Distinctive
  // multi-word phrases are the evidence such a goal DOES carry: they are how the
  // thing is named in prose, and they appear in the code as log strings, target
  // names, comments and identifiers-with-separators.
  test("extracts a distinctive noun phrase when the goal names no symbol", () => {
    const terms = extractSearchTerms(
      "The deploy can report success even though it shipped the wrong commit. Make the deploy fail loudly instead.",
    );
    expect(terms.length).toBeGreaterThan(0);
    // A phrase, not a bare stopword-adjacent noun.
    expect(terms.some((t) => t.includes(" "))).toBe(true);
  });

  test("phrases never outrank a named symbol", () => {
    // Ordering is the contract: the caller stops at the first term that yields a
    // unique hit, so a vague phrase ahead of a real identifier would resolve the
    // wrong file while the right one sat second.
    const terms = extractSearchTerms(
      "Fix `resolvePathlessCodeChangeGoal` so the deploy reports the wrong commit loudly",
    );
    expect(terms[0]).toBe("resolvePathlessCodeChangeGoal");
  });

  test("still refuses to invent a phrase out of pure filler", () => {
    // The fail-closed property must survive: no phrase may be built from words
    // that carry no information, or this becomes a random-file generator.
    for (const goal of [
      "fix the code",
      "make it work properly",
      "update the thing so it does the right thing",
    ]) {
      expect(extractSearchTerms(goal)).toEqual([]);
    }
  });
});

describe("consensusSymbols", () => {
  test("keeps what recurs across samples", () => {
    expect(consensusSymbols([
      ["goal_execution_paths", "execution_path"],
      ["goal_execution_paths", "activity_execution_traces"],
      ["goal_execution_paths"],
    ])[0]).toBe("goal_execution_paths");
  });

  test("drops one-off guesses when something else recurs", () => {
    const out = consensusSymbols([["a_name", "one_off"], ["a_name", "other_off"]]);
    expect(out).toContain("a_name");
    expect(out).not.toContain("one_off");
    expect(out).not.toContain("other_off");
  });

  test("orders by agreement first, then specificity", () => {
    const out = consensusSymbols([
      ["short_one", "a_much_longer_name"],
      ["short_one", "a_much_longer_name"],
      ["short_one"],
    ]);
    expect(out[0]).toBe("short_one"); // 3 votes beats 2, despite being shorter
    expect(out[1]).toBe("a_much_longer_name");
  });

  test("falls back to the union when nothing recurs", () => {
    // One sample's guess is still better than none, and every downstream gate
    // still has to accept it.
    const out = consensusSymbols([["short_a"], ["a_longer_name_b"]]);
    expect(out.length).toBe(2);
    expect(out[0]).toBe("a_longer_name_b"); // tie on votes → longer name first
    expect(out).toContain("short_a");
  });

  test("a single sample degrades to that sample, specificity-ordered", () => {
    expect(consensusSymbols([["short", "much_longer_name"]])[0]).toBe("much_longer_name");
  });

  test("empty and blank input yield nothing rather than throwing", () => {
    expect(consensusSymbols([])).toEqual([]);
    expect(consensusSymbols([[], [""], ["   "]])).toEqual([]);
  });

  test("duplicates WITHIN one sample do not count as agreement", () => {
    // Otherwise a model repeating itself once would look like consensus.
    const out = consensusSymbols([["dup", "dup", "dup"], ["other"]]);
    expect(out.length).toBe(2); // no recurrence across samples → union
  });
});

describe("isPathlessCodeChangeGoal — a NORMATIVE claim is a change ask", () => {
  // THE DEFECT: the gate demanded an imperative edit verb (edit/fix/change/add).
  // A person reporting a defect states the DESIRED BEHAVIOUR instead, using a
  // domain verb — "should refuse", "should prefer" — so real symptom goals were
  // declined and walked as reports. Measured 2026-08-11: the producer-selection
  // goal below was answered with `stdout: "46"` and graded reached, having
  // changed nothing. Law 13 — if a goal only works once the operator rewrites it
  // as an edit instruction, that rewriting is the gap.
  test("the two live goals that were wrongly declined are now admitted", () => {
    expect(
      isPathlessCodeChangeGoal(
        "When goal-host-vessel looks up a producer through discovery it takes whichever vessel the registry happens to list first. Producer selection should prefer a reachable local producer over a remote one.",
      ),
    ).toBe(true);
    expect(
      isPathlessCodeChangeGoal(
        "development-vessel keeps accepting new long-running work while draining. Once draining has begun, the vessel should refuse new long-running requests instead of admitting work it cannot finish.",
      ),
    ).toBe(true);
  });

  test("other modals count too", () => {
    expect(isPathlessCodeChangeGoal("The resolver must not drop the org id from the handler.")).toBe(true);
    expect(isPathlessCodeChangeGoal("The parser needs to reject an empty schema.")).toBe(true);
  });

  test("an imperative edit verb still works (unchanged path)", () => {
    expect(isPathlessCodeChangeGoal("Fix the resolver so it stops dropping the org id.")).toBe(true);
  });
});

describe("isPathlessCodeChangeGoal — widening must NOT swallow reports", () => {
  // The disqualifiers run first and are untouched; these are the cases that make
  // that load-bearing. "Explain why X should prefer Y" contains the normative
  // clause AND a code target, so only NOT_A_CHANGE keeps it a report.
  test("a report ABOUT what the code should do is still a report", () => {
    expect(isPathlessCodeChangeGoal("Explain why the resolver should prefer a local producer.")).toBe(false);
    expect(isPathlessCodeChangeGoal("Audit the code and report which handlers should be updated.")).toBe(false);
    expect(isPathlessCodeChangeGoal("Describe how the vessel handles draining.")).toBe(false);
  });

  test("a counting question is not a change ask", () => {
    expect(isPathlessCodeChangeGoal("How many resolvers should be registered?")).toBe(false);
    expect(isPathlessCodeChangeGoal("Count the .ts files in the codebase.")).toBe(false);
  });

  test("a prose destination still declines", () => {
    expect(isPathlessCodeChangeGoal("Write up in my notes why the endpoint should retry.")).toBe(false);
  });

  test("a goal naming a path is still handled by the path route, not this one", () => {
    expect(
      isPathlessCodeChangeGoal("repos/goal-host-vessel/src/index.ts should prefer a local producer."),
    ).toBe(false);
  });
});

describe("extractSearchTerms — kebab-case module names are locators, not prose", () => {
  // THE DEFECT: steps 1-3 covered backticked spans, camelCase, snake_case,
  // `<x>-vessel` and known repos. A kebab-case MODULE name matched none of them and
  // was never a candidate — while prose phrases WERE extracted. Measured
  // 2026-08-11: a goal naming `vacuous-edit` (a real file, and the strongest
  // locator it carried) produced 28 terms with vacuous-edit at index -1, and the
  // phrase "makes every" — from "which makes every invocation loop forever" — won
  // instead, routing the edit to an unrelated file where the drafter invented an
  // anchor. Nearly every file in these vessels is kebab-case, so this was the
  // common case being unreachable, not a corner case.
  const GOAL =
    "development-vessel already refuses plans through the vacuous-edit check used by " +
    "feature_compose; it needs a sibling check, which makes every invocation safe.";

  test("the module name is extracted at all", () => {
    expect(extractSearchTerms(GOAL)).toContain("vacuous-edit");
  });

  test("a real name outranks a prose phrase — the caller stops at the first hit", () => {
    const t = extractSearchTerms(GOAL);
    expect(t.indexOf("vacuous-edit")).toBeGreaterThanOrEqual(0);
    expect(t.indexOf("vacuous-edit")).toBeLessThan(t.indexOf("makes every"));
  });

  test("other real module names in this codebase are reachable", () => {
    for (const name of ["compose-slots", "satisfier-pick", "provider-errors", "cross-file-symbols"]) {
      expect(extractSearchTerms(`the ${name} helper is wrong`)).toContain(name);
    }
  });

  test("vessel and repo names keep their existing handling, not duplicated here", () => {
    const t = extractSearchTerms("fix development-vessel and activity-api");
    expect(t.filter((x) => x === "development-vessel").length).toBe(1);
    expect(t).toContain("activity-api");
  });

  test("hyphenated prose is harmless — it simply matches no file", () => {
    // Not filtered by a stop-list on purpose: the resolver demands a UNIQUE file
    // hit, so a term naming nothing costs one search and yields nothing. A
    // stop-list would be another thing to keep correct.
    const t = extractSearchTerms("make the check fail-open and read-only");
    expect(t).toContain("fail-open");
  });
});

// ---------------------------------------------------------------------------
// Vocabulary widening, 2026-08-11.
//
// Four symptom-only goals were dispatched live and all four returned reached:no.
// Two of them (1f4c0881, 3e841434) never entered this resolver AT ALL:
// isPathlessCodeChangeGoal returned false and extractSearchTerms returned [], so
// the LLM symptom-to-identifier bridge behind it never ran. Cause was two
// vocabulary holes, not architecture:
//   - MUTATION_VERB listed 22 verbs and none of the make-a-rule-less-restrictive
//     family, which is one of the commonest repair shapes this substrate
//     generates about itself.
//   - CODE_TARGET listed the abbreviated spelling of a match rule but not the
//     two-word form, nor the words a symptom report naturally uses for a
//     predicate.
// The widening is safe because every downstream gate is untouched: a goal that
// now enters still has to have the search single out EXACTLY ONE file, or it
// falls through unrestated.
// ---------------------------------------------------------------------------
describe("vocabulary: goals that ask to make a too-narrow rule less narrow", () => {
  // Verbatim text of live dispatch 3e841434.
  const D4 =
    "The regular " + "expression that recognises a redundant re-minted activity template is too " +
    "narrow and must be widened. It currently requires the template id to end with a run of at " +
    "least ten digits, so it matched 1,623 older rows and zero of the 95 templates minted this week.";
  // Verbatim text of live dispatch 1f4c0881.
  const D3 =
    "Duplicate activity templates that share an identical name are never merged into one, so the " +
    "pool keeps growing and selection traffic splits across copies of the same behaviour. The " +
    "merge gate only recognises an id that ends in a ten-digit timestamp suffix, so the " +
    "deduplicating upsert matches nothing. Widen the condition that decides a template is a " +
    "redundant re-mint.";

  test("THE REGRESSION: both live goals now enter the resolver", () => {
    expect(isPathlessCodeChangeGoal(D4)).toBe(true);
    expect(isPathlessCodeChangeGoal(D3)).toBe(true);
  });

  test("and they yield searchable terms rather than an empty list", () => {
    expect(extractSearchTerms(D4).length).toBeGreaterThan(0);
    expect(extractSearchTerms(D3).length).toBeGreaterThan(0);
  });

  test("each newly-added verb qualifies on its own", () => {
    for (const verb of ["widen", "broaden", "loosen", "relax", "tighten", "narrow", "extend"]) {
      expect(isPathlessCodeChangeGoal(`${verb} the predicate in the resolver`)).toBe(true);
    }
  });

  test("THE BOUNDARY: reports and prose asks are still refused", () => {
    // These carry the new vocabulary but are not change requests. If any of these
    // flips to true the widening has started swallowing read-only goals, which is
    // the failure the disqualifiers exist to prevent.
    expect(isPathlessCodeChangeGoal(
      "Report how many activity templates were minted this week and summarise the duplicate-name families.",
    )).toBe(false);
    expect(isPathlessCodeChangeGoal(
      "Update my notes about the gap queue and write a summary document.",
    )).toBe(false);
    expect(isPathlessCodeChangeGoal(
      "Explain which condition decides that a template is a redundant re-mint.",
    )).toBe(false);
  });

  test("a goal naming a path is still not 'pathless'", () => {
    expect(isPathlessCodeChangeGoal("Widen the check in repos/activity-api/src/routes/activities.ts")).toBe(false);
  });
});

describe("phantom self-match discipline", () => {
  // extractSearchTerms greps the WORKSPACE, which contains this vessel. Any phrase
  // written literally in the resolver's own source becomes a unique match for every
  // goal containing it, and the resolver would restate that goal onto this file with
  // full confidence. The call site already records that this has happened before.
  //
  // It happened again while writing the widening above: a first draft spelled the
  // two-word form of "match rule" in a comment, which took it from 0 files
  // fleet-wide to exactly 1 — this one. This test makes the rule mechanical instead
  // of a comment someone has to notice.
  test("the resolver's own source contains no literal phrase a goal is likely to use", async () => {
    const src = await Bun.file(new URL("./goal-file-resolution.ts", import.meta.url)).text();
    // Assembled at runtime so THIS test file does not itself become the phantom.
    const forbidden = ["regular" + " expression", "condition that" + " decides", "timestamp" + " suffix"];
    for (const phrase of forbidden) {
      expect(src.includes(phrase)).toBe(false);
    }
  });
});
