import { describe, expect, test } from "bun:test";
import {
  resolvePathlessCodeChangeGoal,
  extractSearchTerms,
  isPathlessCodeChangeGoal,
  restateWithTargetFile,
  symbolCandidatesFromGoal,
  type FileSearch,
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

describe("symbolCandidatesFromGoal", () => {
  // The measured ceiling of phrase search (2026-08-10): a goal describing a
  // SYMPTOM shares no text with the code. "timestamps ... serialized as empty
  // braces" matched 0 files in activity-api, while the right file declares
  // `TimestampSchema` 24 times. But the symbol's own words — timestamp, schema —
  // are both IN the goal. Matching goal words against declared symbol NAMES
  // bridges the two vocabularies where matching text against text cannot.
  test("recovers a camelCase symbol whose words the goal uses separately", () => {
    const cands = symbolCandidatesFromGoal(
      "timestamps come back from the database as objects and serialize as empty braces; fix the schema code that normalizes those timestamp values",
    );
    expect(cands).toContain("timestamp");
    expect(cands).toContain("schema");
  });

  test("drops filler so the candidate set stays small and specific", () => {
    const cands = symbolCandidatesFromGoal("please fix the thing so it works right");
    expect(cands).toEqual([]);
  });

  test("keeps an identifier the goal states outright", () => {
    expect(symbolCandidatesFromGoal("fix TimestampSchema please")).toContain("TimestampSchema");
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

  test("a named vessel scopes the search instead of being searched for", async () => {
    // Measured live 2026-08-09: grepping for `discovery-vessel` matched 66
    // files across the fleet (everyone who mentions it), read as ambiguous, and
    // dropped through to the vague phrase "vessels register" — which resolved a
    // goal about discovery-vessel onto goal-host-vessel/src/index.ts.
    const seen: Array<{ term: string; vessel?: string }> = [];
    const search: FileSearch = async (term, vessel) => {
      seen.push({ term, vessel });
      return term === "loopback address" ? ["repos/discovery-vessel/src/resolvers.ts"] : [];
    };
    const out = await resolvePathlessCodeChangeGoal(
      "Make the discovery vessel stop advertising a loopback address in its registry code",
      search,
    );
    expect(out).toContain("repos/discovery-vessel/src/resolvers.ts");
    // The vessel name must never be issued as a query...
    expect(seen.map((s) => s.term)).not.toContain("discovery-vessel");
    // ...and every query must carry it as scope.
    expect(seen.every((s) => s.vessel === "discovery-vessel")).toBe(true);
  });

  test("two named vessels are not evidence for either — no scope", async () => {
    const seen: Array<string | undefined> = [];
    const search: FileSearch = async (_t, vessel) => { seen.push(vessel); return []; };
    await resolvePathlessCodeChangeGoal(
      "Make the discovery vessel and the boredom vessel agree on the loopback address rule in their code",
      search,
    );
    expect(seen.every((v) => v === undefined)).toBe(true);
  });

  test("a file declaring symbols for SEVERAL goal words beats one matching a single word", async () => {
    // Measured 2026-08-10: for the TimestampSchema goal, "timestamp" declares in
    // 2 files and "schema" in 4 — so no single word is unique and fail-closed
    // declines. But schemas.ts is the ONLY file in both sets. Corroboration
    // across independent words is stronger evidence than any one word, and it
    // does not weaken the rule: a lone leader is still required.
    const byWord: Record<string, string[]> = {
      timestamp: ["repos/activity-api/src/models/schemas.ts", "repos/activity-api/src/utils/observed-shapes.ts"],
      schema: [
        "repos/activity-api/src/models/schemas.ts",
        "repos/activity-api/src/models/a.ts",
        "repos/activity-api/src/models/b.ts",
      ],
    };
    const symbolSearch: FileSearch = async (w) => byWord[w] ?? [];
    const out = await resolvePathlessCodeChangeGoal(
      "timestamps come back from the database as objects; fix the schema module that normalizes those timestamp values",
      async () => [],
      undefined,
      symbolSearch,
    );
    expect(out).toContain("repos/activity-api/src/models/schemas.ts");
  });

  test("a tie between corroborated files still declines", async () => {
    // Two files each matching two words is not evidence for either.
    const symbolSearch: FileSearch = async () => ["repos/x/src/a.ts", "repos/x/src/b.ts"];
    const goal =
      "timestamps come back from the database as objects; fix the schema module that normalizes those timestamp values";
    expect(await resolvePathlessCodeChangeGoal(goal, async () => [], undefined, symbolSearch)).toBe(goal);
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

// ─────────────────────────────────────────────────────────────────────────────
// PROPOSED SYMBOLS — the symptom→identifier translation.
//
// The goal says "execution-path records" / "tenant marking"; the code says
// `goal_execution_paths` / `org_id`. No lexical rule bridges that, so these
// goals were left unrestated and never reached the compose path.
//
// The proposal only widens the CANDIDATE WORDS — every fail-closed gate is
// unchanged, which is what these cases pin.
// ─────────────────────────────────────────────────────────────────────────────
describe("resolvePathlessCodeChangeGoal — proposed symbols", () => {
  const noPhrase: FileSearch = async () => [];
  // NOTE the code noun ("handler"). `isPathlessCodeChangeGoal` deliberately
  // requires one — a mutation verb alone would send report goals into
  // feature_compose, which drafts and COMMITS. These cases exercise the symbol
  // proposal, not that gate.
  const symptomGoal =
    "The handler that writes execution-path records sets no tenant marking, so tenant-filtered reads see nothing. Fix it.";

  test("restates when a proposed symbol declares in exactly one file", async () => {
    const symbolSearch: FileSearch = async (term) =>
      term === "goal_execution_paths" ? ["repos/activity-api/src/routes/goal-paths.ts"] : [];
    const out = await resolvePathlessCodeChangeGoal(
      symptomGoal, noPhrase, undefined, symbolSearch,
      async () => ["goal_execution_paths"],
    );
    expect(out).toContain("repos/activity-api/src/routes/goal-paths.ts");
  });

  test("does NOT restate when the proposal singles out nothing", async () => {
    // A model guessing wildly must change nothing: the search still has to
    // independently single out one file.
    const symbolSearch: FileSearch = async () => ["a.ts", "b.ts", "c.ts"];
    const out = await resolvePathlessCodeChangeGoal(
      symptomGoal, noPhrase, undefined, symbolSearch,
      async () => ["totallyMadeUp", "alsoWrong"],
    );
    expect(out).toBe(symptomGoal);
  });

  test("a tie among proposed symbols is not evidence", async () => {
    const symbolSearch: FileSearch = async (term) =>
      term === "alpha" ? ["x.ts", "y.ts"] : term === "beta" ? ["x.ts", "y.ts"] : [];
    const out = await resolvePathlessCodeChangeGoal(
      symptomGoal, noPhrase, undefined, symbolSearch, async () => ["alpha", "beta"],
    );
    expect(out).toBe(symptomGoal);
  });

  test("corroboration across proposed symbols needs a STRICT leader", async () => {
    const symbolSearch: FileSearch = async (term) =>
      term === "alpha" ? ["x.ts", "y.ts"] : term === "beta" ? ["x.ts", "z.ts"] : [];
    const out = await resolvePathlessCodeChangeGoal(
      symptomGoal, noPhrase, undefined, symbolSearch, async () => ["alpha", "beta"],
    );
    expect(out).toContain("x.ts"); // x declares 2, y and z declare 1
  });

  test("rejects junk proposals rather than searching for them", async () => {
    // The earlier lexical pass legitimately searches for goal words, so a bare
    // call counter proves nothing. Assert on WHAT was searched: no proposed junk
    // string may reach the search.
    const searched: string[] = [];
    const symbolSearch: FileSearch = async (term) => { searched.push(term); return []; };
    const junk = ["a", "b", "-- drop table --", "x y z", ""];
    const out = await resolvePathlessCodeChangeGoal(
      symptomGoal, noPhrase, undefined, symbolSearch, async () => junk,
    );
    expect(out).toBe(symptomGoal);
    for (const j of junk) expect(searched).not.toContain(j);
  });

  test("a throwing proposer leaves the goal untouched", async () => {
    const symbolSearch: FileSearch = async () => [];
    const out = await resolvePathlessCodeChangeGoal(
      symptomGoal, noPhrase, undefined, symbolSearch,
      async () => { throw new Error("llm down"); },
    );
    expect(out).toBe(symptomGoal);
  });

  test("is never consulted when a lexical route already resolved the file", async () => {
    let proposed = 0;
    const symbolSearch: FileSearch = async (t) =>
      t === "TimestampSchema" ? ["repos/activity-api/src/models/schemas.ts"] : [];
    const out = await resolvePathlessCodeChangeGoal(
      "Fix the TimestampSchema handler so timestamps serialize correctly",
      noPhrase, undefined, symbolSearch,
      async () => { proposed++; return ["somethingElse"]; },
    );
    expect(out).toContain("schemas.ts");
    expect(proposed).toBe(0);
  });
});

describe("proposed symbols — a vaguer name must not win after an ambiguous one", () => {
  // Observed live: proposals were ["goal_execution_paths", "execution_path"].
  // The first is CORRECT but is a table name spread across many activity-api
  // files, so it read as ambiguous; the second matched exactly one file in a
  // completely unrelated vessel and the goal was restated onto it. Only the
  // drafter's "say so rather than editing it" clause prevented a wrong-file
  // commit — and a drafter's judgement is not a gate.
  const goalText =
    "The handler that writes execution-path records sets no tenant marking. Fix it.";
  const noPhrase: FileSearch = async () => [];

  test("stops at the ambiguous specific proposal instead of taking the vague unique one", async () => {
    const symbolSearch: FileSearch = async (term) =>
      term === "goal_execution_paths"
        ? ["repos/activity-api/src/routes/goal-paths.ts", "repos/activity-api/src/routes/impulses.ts"]
        : term === "execution_path"
          ? ["repos/goal-host-vessel/src/index.ts"]
          : [];
    const out = await resolvePathlessCodeChangeGoal(
      goalText, noPhrase, undefined, symbolSearch,
      async () => ["goal_execution_paths", "execution_path"],
    );
    expect(out).toBe(goalText);
    expect(out).not.toContain("goal-host-vessel/src/index.ts");
  });

  test("a unique FIRST proposal is still accepted", async () => {
    const symbolSearch: FileSearch = async (term) =>
      term === "goal_execution_paths" ? ["repos/activity-api/src/routes/goal-paths.ts"] : [];
    const out = await resolvePathlessCodeChangeGoal(
      goalText, noPhrase, undefined, symbolSearch,
      async () => ["goal_execution_paths", "execution_path"],
    );
    expect(out).toContain("repos/activity-api/src/routes/goal-paths.ts");
  });

  test("a proposal matching NOTHING is skipped, not treated as ambiguous", async () => {
    const symbolSearch: FileSearch = async (term) =>
      term === "org_id" ? ["repos/activity-api/src/routes/goal-paths.ts"] : [];
    const out = await resolvePathlessCodeChangeGoal(
      goalText, noPhrase, undefined, symbolSearch,
      async () => ["not_a_real_name", "org_id"],
    );
    expect(out).toContain("goal-paths.ts");
  });
});

describe("proposed symbols — write-context narrowing", () => {
  // The live case: `goal_execution_paths` is a table name every reader mentions,
  // but exactly one file CREATEs it. The goal says the handler "writes" those
  // records, so the write site is the file it means.
  const writeGoal =
    "The handler that writes execution-path records sets no tenant marking. Fix it.";
  const readGoal =
    "The handler that reads execution-path records ignores the tenant column. Fix it.";
  const noPhrase: FileSearch = async () => [];

  const searchWithWriteSite: FileSearch = async (term) => {
    if (term === "CREATE goal_execution_paths") return ["repos/activity-api/src/routes/goal-paths.ts"];
    if (term === "goal_execution_paths")
      return [
        "repos/activity-api/src/routes/goal-paths.ts",
        "repos/activity-api/src/routes/impulses.ts",
        "repos/activity-api/src/lib/posterior-update.ts",
      ];
    return [];
  };
  const noSymbols: FileSearch = async () => [];

  test("an ambiguous identifier resolves to its single WRITE site", async () => {
    const out = await resolvePathlessCodeChangeGoal(
      writeGoal, searchWithWriteSite, undefined, noSymbols,
      async () => ["goal_execution_paths"],
    );
    expect(out).toContain("repos/activity-api/src/routes/goal-paths.ts");
  });

  test("narrowing does NOT fire when the goal is about reading", async () => {
    // A read goal must not be steered to the write site; the ambiguity stands.
    const out = await resolvePathlessCodeChangeGoal(
      readGoal, searchWithWriteSite, undefined, noSymbols,
      async () => ["goal_execution_paths"],
    );
    expect(out).toBe(readGoal);
  });

  test("two write sites are still ambiguous — no restatement", async () => {
    const twoWriters: FileSearch = async (term) =>
      term === "CREATE goal_execution_paths" ? ["a.ts", "b.ts"]
        : term === "goal_execution_paths" ? ["a.ts", "b.ts", "c.ts"] : [];
    const out = await resolvePathlessCodeChangeGoal(
      writeGoal, twoWriters, undefined, noSymbols, async () => ["goal_execution_paths"],
    );
    expect(out).toBe(writeGoal);
  });

  test("a throwing narrow search does not read as 'no write site'", async () => {
    const throwing: FileSearch = async (term) => {
      if (term.startsWith("CREATE ")) throw new Error("grep blew up");
      if (term === "goal_execution_paths") return ["a.ts", "b.ts"];
      return [];
    };
    const out = await resolvePathlessCodeChangeGoal(
      writeGoal, throwing, undefined, noSymbols, async () => ["goal_execution_paths"],
    );
    expect(out).toBe(writeGoal);
  });
});

describe("proposed symbols — specificity ordering", () => {
  const goalText = "The handler that writes execution-path records lacks a tenant column. Fix it.";
  const noPhrase: FileSearch = async () => [];

  test("the LONGER identifier is tried first regardless of model order", async () => {
    // Live, the proposer returned the vague name first on one run and the
    // specific one first on another. Model order is not a specificity signal.
    const symbolSearch: FileSearch = async (term) =>
      term === "goal_execution_paths" ? ["a.ts", "b.ts"]
        : term === "execution_path" ? ["repos/goal-host-vessel/src/index.ts"] : [];
    const out = await resolvePathlessCodeChangeGoal(
      goalText, noPhrase, undefined, symbolSearch,
      async () => ["execution_path", "goal_execution_paths"], // vague listed FIRST
    );
    // The specific name is ambiguous, which disarms lone-unique; the vague name
    // must therefore not win.
    expect(out).toBe(goalText);
  });
});
