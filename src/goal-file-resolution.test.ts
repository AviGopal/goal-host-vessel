import { describe, expect, test } from "bun:test";
import {
  resolvePathlessCodeChangeGoal,
  extractSearchTerms,
  isPathlessCodeChangeGoal,
  restateWithTargetFile,
  symbolCandidatesFromGoal,
  productionCandidates,
  consensusSymbols,
  wantsCallSitesOf,
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

describe("restateWithTargetFile — the anchor", () => {
  test("names the term in the phrasing feature-compose PARSES", () => {
    // `regionFromProposalText` matches exactly `in the region "X"` and uses it to
    // focus the grounding window. Prose like "the relevant code is around X" is
    // unparseable: 30 dispatches logged `region: null` and the window was never
    // focused.
    const out = restateWithTargetFile("fix the thing", "repos/a/src/b.ts", "goal_execution_paths");
    expect(out).toContain("repos/a/src/b.ts");
    expect(out).toMatch(/in the region "goal_execution_paths"/);
    expect(out).toContain("wrong target"); // the escape clause survives
  });

  test("the emitted clause round-trips through the parser that consumes it", () => {
    // Pin the CONTRACT, not the wording: this is the same regex feature-compose
    // uses (regionFromProposalText). If either side is reworded, this fails.
    const out = restateWithTargetFile("g", "f.ts", "activity_execution_traces");
    const parsed = out.match(/\bin the region\s+"([^"]{2,120})"/i)?.[1];
    expect(parsed).toBe("activity_execution_traces");
  });

  test("omits the clause entirely when there is no anchor", () => {
    // Callers that resolved by a route with no meaningful term must not emit an
    // empty backtick pair — a hint that says nothing is worse than none.
    const out = restateWithTargetFile("fix the thing", "repos/a/src/b.ts");
    expect(out).not.toContain("in the region");
    expect(out).toContain("wrong target");
  });

  test("blank and whitespace anchors are treated as absent", () => {
    for (const a of ["", "   "]) {
      expect(restateWithTargetFile("g", "f.ts", a)).not.toContain("in the region");
    }
  });

  test("an anchor is a HINT, so the wrong-target escape is still offered", () => {
    // A mis-resolved anchor must remain refusable by the drafter.
    const out = restateWithTargetFile("g", "f.ts", "someSymbol");
    expect(out).toContain("say so rather than editing it");
  });
});

describe("productionCandidates", () => {
  test("drops seed/script/fixture paths", () => {
    expect(productionCandidates([
      "repos/activity-api/scripts/seed-cleanup-test-data.ts",
      "repos/activity-api/src/routes/goal-paths.ts",
    ])).toEqual(["repos/activity-api/src/routes/goal-paths.ts"]);
  });

  test("a unique hit in a seed script no longer wins by being alone", async () => {
    // The live failure: `activity_execution_traces` matched exactly one file, a
    // seed script, and the goal was restated onto it. feature_compose then
    // refused because its grounding did not contain that file — the right
    // outcome reached expensively.
    const goalText = "The handler that writes execution-path records lacks a tenant column. Fix it.";
    const noPhrase: FileSearch = async () => [];
    const symbolSearch: FileSearch = async (t) =>
      t === "activity_execution_traces" ? ["repos/activity-api/scripts/seed-cleanup-test-data.ts"] : [];
    const out = await resolvePathlessCodeChangeGoal(
      goalText, noPhrase, undefined, symbolSearch, async () => ["activity_execution_traces"],
    );
    expect(out).toBe(goalText);
  });

  test("is STRICT — nothing survives when every candidate is non-production", () => {
    // No fallback: this filters only the PROPOSAL path, where the words came
    // from a model. A goal genuinely about a script still resolves via the
    // lexical routes, which are not filtered.
    expect(productionCandidates(["repos/a/scripts/x.ts", "repos/b/migrations/y.ts"])).toEqual([]);
  });

  test("does not mistake a path merely CONTAINING the word for a directory", () => {
    expect(productionCandidates(["repos/a/src/test-registration.ts"]))
      .toEqual(["repos/a/src/test-registration.ts"]);
    expect(productionCandidates(["repos/a/src/scripting-helpers.ts"]))
      .toEqual(["repos/a/src/scripting-helpers.ts"]);
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

describe("wantsCallSitesOf — declaration vs call site", () => {
  // THE DEFECT, and it produced the worst change of the session. The goal was
  // "several producer lookups ... should use the pickSatisfierProducer helper ...
  // instead of indexing the first element". The lookups live in index.ts (9 of
  // them); the helper is DECLARED in satisfier-pick.ts. Phrase search matched both
  // and went ambiguous, so the declaration search won and restated the goal onto
  // satisfier-pick.ts.
  //
  // Told to make the helper "use pickSatisfierProducer", the only edit that
  // satisfies the instruction is a self-call:
  //     - return best ?? pool[0];
  //     + return pickSatisfierProducer(pool);
  // which is the non-terminating change that shipped as d96e2ae and hung the
  // vessel. The drafter was answering the question it was given. Localisation was
  // wrong FIRST, and reading it as a drafting failure would have kept repairing
  // the wrong layer.
  const ADOPT =
    "Several producer lookups choose a vessel by taking the first entry. These lookups " +
    "should use the pickSatisfierProducer helper the vessel already has, instead of " +
    "indexing the first element.";

  test("a callers-should-adopt goal is recognised", () => {
    expect(wantsCallSitesOf(ADOPT, "pickSatisfierProducer")).toBe(true);
  });

  test("other adopt phrasings", () => {
    for (const g of [
      "callers should call pickSatisfierProducer",
      "switch to pickSatisfierProducer",
      "route through pickSatisfierProducer",
      "use the pickSatisfierProducer helper",
    ]) {
      expect(wantsCallSitesOf(g, "pickSatisfierProducer")).toBe(true);
    }
  });

  test("a goal that wants the SYMBOL ITSELF changed still targets its declaration", () => {
    // The control that keeps this from inverting every symbol goal.
    expect(wantsCallSitesOf("Fix pickSatisfierProducer so it prefers a local producer.", "pickSatisfierProducer")).toBe(false);
    expect(wantsCallSitesOf("pickSatisfierProducer returns the wrong element", "pickSatisfierProducer")).toBe(false);
  });

  test("the symbol must be the OBJECT of the adopt phrase", () => {
    // A stray "use" elsewhere in the sentence must not qualify.
    expect(wantsCallSitesOf("We use tabs here; rewrite the scoring in someOtherSymbol.", "pickSatisfierProducer")).toBe(false);
  });

  test("empty input is safe", () => {
    expect(wantsCallSitesOf("", "x")).toBe(false);
    expect(wantsCallSitesOf("use the x helper", "")).toBe(false);
  });
});

describe("resolvePathlessCodeChangeGoal — an adopt goal targets the CALLER, not the helper", () => {
  // END-TO-END for the routing defect behind d96e2ae. The phrase search collapses
  // a multi-file match to the file that EXPORTS the term — right for "fix X",
  // wrong for "callers should use X". That collapse reported a UNIQUE hit on the
  // declaration, so the earlier declaration-branch guard never even ran: I fixed
  // one branch while the traffic went through another.
  const GOAL =
    "Several producer lookups in goal-host-vessel choose a vessel by taking the first " +
    "entry the registry hands back. These lookups should use the pickSatisfierProducer " +
    "helper the vessel already has, instead of indexing the first element.";
  const HELPER = "repos/goal-host-vessel/src/satisfier-pick.ts";
  const CALLER = "repos/goal-host-vessel/src/index.ts";

  // Mirrors the real search: without preferCallSites it collapses to the exporter.
  const search: FileSearch = async (t, _v, preferCallSites) =>
    t !== "pickSatisfierProducer" ? [] : preferCallSites ? [CALLER, HELPER] : [HELPER];
  const symbolSearch: FileSearch = async (t) => (t === "pickSatisfierProducer" ? [HELPER] : []);

  test("restates onto the caller", async () => {
    const out = await resolvePathlessCodeChangeGoal(GOAL, search, undefined, symbolSearch);
    expect(out).toContain(CALLER);
  });

  test("does NOT restate onto the declaring file", async () => {
    // Targeting the helper is what made a self-call the only satisfying edit.
    const out = await resolvePathlessCodeChangeGoal(GOAL, search, undefined, symbolSearch);
    expect(out).not.toContain("satisfier-pick.ts");
  });

  test("a fix-the-symbol goal still targets the declaration", async () => {
    const fix = "Fix pickSatisfierProducer in goal-host-vessel so the helper prefers a local producer.";
    const out = await resolvePathlessCodeChangeGoal(fix, search, undefined, symbolSearch);
    expect(out).toContain(HELPER);
  });

  test("ambiguity still fails closed — two callers restate nothing", async () => {
    const twoCallers: FileSearch = async (t, _v, p) =>
      t !== "pickSatisfierProducer" ? [] : p ? [CALLER, "repos/goal-host-vessel/src/other.ts", HELPER] : [HELPER];
    const out = await resolvePathlessCodeChangeGoal(GOAL, twoCallers, undefined, symbolSearch);
    expect(out).toBe(GOAL); // unchanged
  });
});
