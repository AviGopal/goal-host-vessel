/**
 * Resolving a code-change goal that did not name a file.
 *
 * WHY THIS EXISTS (2026-08-09). `isEditIntentGoal` ANDs a mutation verb with a
 * literal `repos/<vessel>/<path>.<ext>`:
 *
 *     /repos\/[\w.-]+\/[\w.\/-]+\.\w+/.test(goal) && /\b(edit|add|fix|…)\b/i.test(goal)
 *
 * so a goal that asks for a change but does not already contain the path is not
 * an edit goal at all. Measured on two live hub dispatches: "Fix this so
 * consumers resolve an address they can actually reach" inferred
 * ["shellResult","memoryNote_write"], and "Write and land the code change, do
 * not just describe it" inferred ["llm_completion_dispatch"] with NO
 * alternatives. Neither produced a commit. No edit shape appeared in either
 * primary set or either alternatives list, because for a pathless goal the edit
 * family is never a candidate to rank in the first place.
 *
 * That is law 13 as a boolean: "if a goal only works after an operator rewrites
 * it with file paths, that rewriting is a gap in the system, not a workflow to
 * institutionalize."
 *
 * WHY NOT JUST RELAX THE `&&`. The path is not consulted once — `goal.match(
 * /repos\/[\w.-]+\/[\w./-]+/)` recurs at roughly a dozen sites in index.ts. A
 * predicate that admits pathless goals hands every one of those a null match, so
 * the goal would enter the edit path and misfire deeper in, which is strictly
 * worse than declining it early. The path requirement is load-bearing.
 *
 * So this module does the decomposition the operator is currently doing by hand:
 * recognise a pathless code-change goal, extract the terms worth searching for,
 * and restate the goal with the resolved path so that EVERY existing downstream
 * consumer — the predicate, the path extractors, feature_compose — works
 * unchanged. The filesystem search itself is deliberately NOT here: it is
 * injected, so this module stays pure and directly testable (index.ts boots a
 * server on import and cannot be tested).
 */

/** Mutation verbs — kept in sync with `isEditIntentGoal` in ./goal-intent. */
const MUTATION_VERB =
  /\b(edit|add|insert|append|prepend|change|modify|replace|fix|remove|delete|update|rename|refactor|wire|guard|implement|land|patch|correct|stop|make|harden|teach)\b/i;

/**
 * Evidence the goal is about CODE rather than data, prose, or the running fleet.
 *
 * Required so that "fix the gap queue" or "update my notes" do not become edit
 * goals. A mutation verb alone is far too common — it appears in report asks
 * ("report which vessels changed"), in analysis asks, and in gap prose.
 */
const CODE_TARGET =
  /\b(code|codebase|source|sources?\s+file|implementation|function|method|class|module|predicate|regex|handler|resolver|vessel|endpoint|route|parser|schema|typescript|\.ts\b|\.tsx\b|\.js\b|logic|branch|guard|helper|the\s+fleet'?s?\s+code|scripts?|shell\s+scripts?|\.sh\b|makefile|deploy\s+(?:path|script|step)|entrypoint|unit\s+file|systemd\s+unit)\b/i;

/**
 * Asks that must NOT be treated as code changes even when they carry a mutation
 * verb and mention code. These have their own paths (analysis, prose, inventory)
 * and diverting them to the edit path would be the "tries and misfires" failure
 * this module exists to avoid.
 */
// `count` is anchored to a counting ASK ("count the resolvers"), never the bare
// word: as a plain alternation it also matched "so scripts count as code" and
// vetoed an unambiguous edit request. Measured 2026-08-09 — a veto term must
// match the request, not merely the vocabulary of the request.
const NOT_A_CHANGE =
  /\b(explain|describe|summar\w*|what\s+(is|are|does|do)\b|why\s+(do|does|did|is|are)\b|how\s+many|count\s+(?:the|all|how|every)\b|list all|report the (?:number|count)|audit|review|analy[sz]e|investigate|diagnose|find out|tell me about|walk me through|overview)\b/i;

/**
 * Prose/data destinations that outrank any code word later in the sentence.
 *
 * "Update my notes about the deploy script" is a note edit, not a code edit —
 * but it carries a mutation verb and (since `script` joined CODE_TARGET) a code
 * target too. Widening the code vocabulary made this class newly reachable, so
 * the destination has to be checked explicitly. Caught by the regression test
 * written alongside that widening, not in review.
 */
const PROSE_DESTINATION =
  /\b(?:my|the)\s+(?:notes?|vault|journal|memory|doc|docs|documentation|write-?up)\b|\badd\s+a\s+note\b|\bnote\s+(?:about|describing|that)\b/i;

/**
 * Repos that are NOT `<name>-vessel`, so the vessel-name rules above cannot see
 * them. Listed explicitly rather than inferred: a "two hyphenated words" guess
 * would mint scopes for phrases that name no repository, and a scope that does
 * not exist silently narrows the search to nothing.
 *
 * A name missing here costs a fallback to phrase search (today's behaviour), so
 * drift is degrading, not breaking. `-vessel` repos are matched by pattern and
 * deliberately absent.
 */
const KNOWN_REPOS = [
  "activity-api",
  "concept-db",
  "cpg-inference-ts",
  "ias-executor-ts",
  "libp2p-federation-transport",
] as const;

/**
 * Multi-word vessel repos, for recognising "the goal host code". Only names
 * whose spaced form is ambiguous with ordinary prose need to be here; a
 * single-word vessel ("the discovery vessel") is already handled by pattern.
 */
const KNOWN_VESSELS = [
  "goal-host-vessel",
  "local-tools-vessel",
  "llm-resolver-vessel",
  "light-dispatch-vessel",
  "metric-collector-vessel",
  "stateful-ui-vessel",
  "human-surface-vessel",
] as const;

/** A goal that already names a file needs no resolution — it is already routable. */
const HAS_PATH = /repos\/[\w.-]+\/[\w.\/-]+\.\w+/;

/**
 * Spans where a word appears only to be RULED OUT.
 *
 * "Write and land the code change, do not just describe it" is the clearest
 * possible edit instruction, and it was rejected because `describe` appears in
 * it — inside the clause forbidding description. Measured on hub dispatch
 * 72f02fea, whose author (me) was trying to force an edit and produced the
 * opposite. Any goal that anticipates the failure mode and says "don't just
 * report" trips the report guard; the more precise the instruction, the more
 * likely it is to carry the negated word. That is the explicitness
 * anti-correlation showing up as a lexical bug rather than a model one.
 *
 * Strip these spans before applying the disqualifiers, so a disqualifier only
 * fires when the goal is ASKING for that thing.
 */
const NEGATED_SPAN =
  /\b(?:do\s+not|don'?t|never|rather\s+than|instead\s+of|not\s+just|no\s+need\s+to|without)\b[^.;!?]*/gi;

/**
 * A code-change ask that omits the file path.
 *
 * Deliberately conservative: a mutation verb AND a code target AND no existing
 * path AND no analysis/prose lead. A false negative costs what we already have
 * today (the goal walks as a report). A false positive sends a report goal into
 * feature_compose, which drafts and commits — so the guard errs toward declining.
 */
export function isPathlessCodeChangeGoal(goal: string): boolean {
  if (HAS_PATH.test(goal)) return false;
  // Disqualifiers are judged on what the goal ASKS for, so negated clauses
  // ("do not just describe it") are removed first. The mutation verb and code
  // target are still read from the FULL text: "don't touch the parser" should
  // not become an edit goal, but the parser is still what it is about.
  const asked = goal.replace(NEGATED_SPAN, " ");
  if (NOT_A_CHANGE.test(asked)) return false;
  if (PROSE_DESTINATION.test(asked)) return false;
  return MUTATION_VERB.test(asked) && CODE_TARGET.test(goal);
}

/**
 * Terms worth grepping the workspace for, most specific first.
 *
 * Ordered by how much they narrow the search, because the caller stops at the
 * first term that yields a usable hit: quoted spans and identifier-shaped tokens
 * (camelCase, snake_case, dotted) name real symbols; bare words rarely do. A
 * search that starts with the vaguest term finds thousands of files and picks
 * one at random, which is the confabulation this is meant to prevent.
 */
export function extractSearchTerms(goal: string): string[] {
  const out: string[] = [];
  const push = (t: string | undefined) => {
    const v = (t ?? "").trim();
    // 3 chars filters out "is", "to", "ts" — noise that matches everything.
    if (v.length >= 3 && !out.includes(v)) out.push(v);
  };

  // 1. Backticked or quoted spans: the author pointing at a literal.
  for (const m of goal.matchAll(/[`"']([A-Za-z_][\w.$-]{2,})[`"']/g)) push(m[1]);

  // 2. Identifier-shaped tokens: camelCase, snake_case, or dotted.
  for (const m of goal.matchAll(/\b([a-z][a-zA-Z0-9]*[A-Z][A-Za-z0-9]*)\b/g)) push(m[1]);
  for (const m of goal.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) push(m[1]);

  // 3. Named vessels — narrows to a repo even when no symbol is given, and is
  //    the STRONGEST locating signal a pathless goal can carry: it names the
  //    repository outright. Both spellings, because a person writes "the
  //    discovery vessel" and only tooling writes "discovery-vessel".
  //
  //    Measured 2026-08-09: with the hyphenated form alone, "make the discovery
  //    vessel prefer a reachable endpoint" resolved onto goal-host-vessel's
  //    index.ts — the loose phrase "vessels register" happened to hit one file
  //    first, and first unique hit wins. The goal named its target explicitly
  //    and the resolver edited a different vessel.
  for (const m of goal.matchAll(/\b([a-z][a-z0-9-]*-vessel)\b/g)) push(m[1]);
  for (const m of goal.matchAll(/\b([a-z][a-z0-9-]*)\s+vessel\b/gi)) {
    const name = m[1].toLowerCase();
    // "the vessel", "a vessel", "each vessel" name nothing.
    if (FILLER.has(name) || name === "vessel") continue;
    push(`${name}-vessel`);
  }
  // Multi-word vessel names with the suffix dropped: people say "the goal host
  // code", not "goal-host-vessel". Measured 2026-08-09 — that phrasing resolved
  // to nothing.
  //
  // Checked against KNOWN_VESSELS, never minted. The unguarded version of this
  // loop produced `timestamps-come-vessel`, `judges-reach-vessel` and four more
  // from ordinary prose; each would have been issued as a search term and, worse,
  // accepted as a SCOPE — narrowing the search to a directory that cannot exist.
  for (const m of goal.matchAll(/\b([a-z][a-z0-9]{2,})[\s-]+([a-z][a-z0-9]{2,})\b/gi)) {
    const candidate = `${m[1].toLowerCase()}-${m[2].toLowerCase()}-vessel`;
    if ((KNOWN_VESSELS as readonly string[]).includes(candidate)) push(candidate);
  }
  // Repos whose names do NOT end in -vessel, written as words. Measured
  // 2026-08-09: "fix the activity api schema" and "the goal host code" both died
  // with "no unique file", because a -vessel-only rule cannot name activity-api,
  // concept-db, cpg-inference-ts, ias-executor-ts or libp2p-federation-transport.
  // Matched against the KNOWN repo list rather than a shape guess — inventing
  // "<word>-<word>" from arbitrary prose would fabricate scopes that do not exist.
  for (const repo of KNOWN_REPOS) {
    const spaced = repo.replace(/-/g, "[\\s-]+");
    if (new RegExp(`\\b${spaced}\\b`, "i").test(goal)) push(repo);
  }

  // 4. Distinctive noun phrases — LAST, so a phrase can never outrank a real
  //    symbol (the caller stops at the first unique hit).
  //
  //    Why this exists: an operator describing a BEHAVIOUR names no camelCase
  //    token, so steps 1-3 returned [] and the goal was declined for want of a
  //    search term — measured 2026-08-09 on "the deploy reports success even
  //    though it shipped the wrong commit". The phrase IS the evidence such a
  //    goal carries: it is how the thing is named in prose, and prose names
  //    recur in code as log strings, target names and comments.
  //
  //    Two content words, adjacent, neither a stopword. Two rather than one
  //    because single content words ("deploy", "commit") match half the tree and
  //    the caller requires EXACTLY ONE hit — a too-common term does not resolve
  //    the wrong file, it resolves nothing, which is the safe direction.
  for (const phrase of distinctivePhrases(goal)) push(phrase);

  return out;
}

/**
 * Words that carry no locating information. A phrase built only from these
 * would be a random-file generator, so both halves of a phrase must be content
 * words. Includes the mutation verbs and generic nouns that appear in virtually
 * every goal ("fix the code", "make it work") precisely because their presence
 * says nothing about WHERE.
 */
const FILLER = new Set([
  "the", "a", "an", "it", "its", "this", "that", "these", "those", "there",
  "and", "or", "but", "so", "if", "when", "then", "than", "even", "though",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "can", "could", "should", "would", "will", "may", "might", "must", "have",
  "has", "had", "we", "our", "us", "you", "your", "they", "them", "their",
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "into", "about",
  "not", "no", "any", "all", "some", "one", "two", "very", "just", "only",
  "instead", "rather", "actually", "really", "properly", "correctly",
  "fix", "make", "update", "change", "add", "remove", "stop", "thing", "things",
  "work", "works", "right", "wrong", "good", "bad", "new", "old", "code",
  "please", "need", "needs", "want", "let", "get", "gets", "put", "use", "uses",
  // Interrogatives and clause connectives. They sit BETWEEN ideas, so a pair
  // built across one ("commit nothing", "what landed") reads as a unit the
  // author never wrote — observed verbatim on the first live extraction.
  "what", "which", "who", "whom", "whose", "where", "why", "how",
  "nothing", "something", "anything", "everything", "because", "while",
  "against", "though", "although", "unless", "until", "whether",
]);

/**
 * Adjacent content-word pairs, in the order they appear.
 *
 * Deliberately dumb: no stemming, no ranking, no model. The pair either occurs
 * verbatim in a file or it does not, and the caller's exactly-one-hit rule does
 * the discriminating. A cleverer extractor would produce more candidates, and
 * more candidates means more chances to resolve confidently onto a wrong file —
 * the one failure this module exists to prevent.
 */
function distinctivePhrases(goal: string): string[] {
  const out: string[] = [];
  // Sentence-bounded so a phrase cannot span a full stop and read as a unit
  // the author never wrote.
  for (const sentence of goal.split(/[.;!?\n]+/)) {
    const words = sentence
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((w) => w.length >= 3 && !FILLER.has(w));
    // Only pairs that were ADJACENT in the original sentence survive: filtering
    // first would join words that never touched, inventing a phrase.
    const raw = sentence.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i];
      const b = raw[i + 1];
      if (a.length < 3 || b.length < 3) continue;
      if (FILLER.has(a) || FILLER.has(b)) continue;
      if (!words.includes(a) || !words.includes(b)) continue;
      out.push(`${a} ${b}`);
    }
  }
  return out;
}

/**
 * Restate the goal so the EXISTING machinery routes it.
 *
 * The path goes in the LEAD SENTENCE because that is what the documented
 * edit-intent contract keys on ("a goal whose lead sentence names a real
 * repos/<vessel>/src/… file"), and the original text is preserved verbatim
 * underneath so the drafter still sees what was actually asked for — dropping it
 * would replace the operator's intent with a filename.
 *
 * The resolution is stated as an inference rather than a fact so a wrong guess is
 * visible in the trace and to the drafter, instead of masquerading as something
 * the operator specified.
 */
export function restateWithTargetFile(goal: string, file: string): string {
  return `Edit ${file} to satisfy the following request. If that file is the wrong target, say so rather than editing it.\n\n${goal.trim()}`;
}

/**
 * Words from the goal that could be PARTS of a declared symbol name.
 *
 * Why this exists, measured 2026-08-10: phrase search has a hard ceiling that
 * no amount of tuning moves. A goal describing a symptom — "timestamps come
 * back as objects and serialize as empty braces" — shares NO text with the code
 * that causes it: `timestamp values`, `empty braces`, `real dates` each matched
 * **zero** files in activity-api, while the file that owns the bug declares
 * `TimestampSchema` twenty-four times.
 *
 * The bridge is that a symbol's own words usually ARE in the goal, just never
 * adjacent and never in the code's casing: TimestampSchema = timestamp + schema,
 * and the goal says both. So this yields single words to be matched against
 * DECLARED SYMBOL NAMES (see the definition-site search), not against file text
 * — text-vs-text is the comparison that cannot work.
 *
 * Single words are far weaker evidence than a phrase, which is why they are used
 * ONLY against definition sites: `grep "^export const .*timestamp"` is a narrow
 * question, while grepping files for "timestamp" is not a question at all.
 */
export function symbolCandidatesFromGoal(goal: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of goal.split(/[^A-Za-z0-9_$]+/)) {
    if (!raw) continue;
    // An identifier the operator typed outright is the strongest form and is
    // kept verbatim — casing included, since that is how it appears in code.
    const isIdentifierShaped = /[a-z][A-Z]|_/.test(raw);
    const word = isIdentifierShaped ? raw : raw.toLowerCase();
    if (word.length < 4) continue; // "code", "the", "api" match everything
    if (!isIdentifierShaped && FILLER.has(word)) continue;
    if (!isIdentifierShaped && SYMBOL_NOISE.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/**
 * Words that are common in goals AND common in code, so they discriminate
 * nothing as a symbol fragment. Distinct from FILLER, which is about whether a
 * goal is asking for a change; this is about whether a word can locate a file.
 */
const SYMBOL_NOISE = new Set([
  "this", "that", "there", "these", "those", "then", "than", "when", "where",
  "with", "from", "into", "onto", "over", "under", "after", "before", "while",
  "does", "done", "doing", "made", "make", "makes", "take", "takes", "give",
  "back", "down", "just", "only", "also", "even", "still", "always", "never",
  "some", "such", "same", "each", "every", "both", "either", "other", "another",
  "thing", "things", "stuff", "case", "cases", "part", "parts", "side",
  "should", "would", "could", "might", "must", "will", "shall", "cannot",
  "actually", "really", "properly", "correctly", "instead", "rather",
  "please", "need", "needs", "want", "wants", "like", "look", "looks",
  "because", "since", "though", "although", "however", "therefore",
  "code", "codebase", "source", "file", "files", "line", "lines",
]);

/** Returns repo-relative `repos/<vessel>/…` paths containing the term. */
export type FileSearch = (
  term: string,
  /** Restrict the search to this vessel's repo, when the goal named one. */
  vessel?: string,
) => Promise<readonly string[]>;

/**
 * Turn a pathless code-change goal into a path-bearing one, or return it unchanged.
 *
 * FAIL-CLOSED ON PURPOSE, in three places: the goal must satisfy the
 * conservative predicate, the search must return EXACTLY ONE file, and any
 * search error returns the original goal. The cost asymmetry drives this — a
 * goal left pathless behaves exactly as it does today (it walks and reports,
 * which is the status quo), while a goal restated onto the WRONG file routes a
 * confident edit into feature_compose, which drafts and commits. One is a
 * missed opportunity; the other writes code nobody asked for.
 *
 * Terms are tried in specificity order and the FIRST unique hit wins.
 * Ambiguity is treated as failure rather than resolved by ranking: with two
 * candidate files there is no evidence here for choosing between them, and
 * picking the first is exactly the guess this whole module exists to prevent.
 * THIS FUNCTION IS FAIL-CLOSED. See the module docstring for a full explanation of why.
 */
export async function resolvePathlessCodeChangeGoal(
  goal: string,
  search: FileSearch,
  tap?: (message: string) => void,
  /** Optional: files DECLARING a symbol containing this word. See the last-resort block. */
  symbolSearch?: FileSearch,
  /**
   * Optional: propose CODE IDENTIFIERS a symptom probably corresponds to.
   *
   * The goal says "execution-path records" and "tenant marking"; the code says
   * `goal_execution_paths` and `org_id`. No lexical rule bridges that — it is a
   * translation, and it is the single reason symptom-level repair goals are left
   * unrestated and therefore never reach the compose path.
   *
   * The proposal only widens the CANDIDATE WORDS. Every gate below is unchanged:
   * a proposed word still has to declare in EXACTLY ONE file, or win
   * corroboration as a strict leader across >=2 words. A model that guesses
   * wildly therefore changes nothing — it cannot restate a goal onto a file the
   * search does not independently single out.
   */
  proposeSymbols?: (goal: string) => Promise<readonly string[]>,
): Promise<string> {
  if (!isPathlessCodeChangeGoal(goal)) return goal;
  const allTerms = extractSearchTerms(goal);
  // A named vessel SCOPES the search instead of being searched for. Grepping a
  // repository's name finds every file that merely mentions it (66 across the
  // fleet for `discovery-vessel`), which reads as ambiguity and drops through
  // to a vaguer term — measured live, that is how a goal about discovery-vessel
  // came to be restated onto goal-host-vessel. Only the first named vessel
  // counts: a goal naming two is not evidence for either.
  const vessels = allTerms.filter(
    (t) => /^[a-z][a-z0-9-]*-vessel$/.test(t) || (KNOWN_REPOS as readonly string[]).includes(t),
  );
  const vessel = vessels.length === 1 ? vessels[0] : undefined;
  const terms = allTerms.filter((t) => !vessels.includes(t));
  if (vessel) tap?.(`pathless code-change goal: scoping the search to ${vessel}`);
  if (terms.length === 0) {
    tap?.(`pathless code-change goal but no searchable term — left unrestated`);
    return goal;
  }
  for (const term of terms) {
    let hits: readonly string[];
    try {
      hits = await search(term, vessel);
    } catch {
      // A broken search must not silently become "no such file".
      tap?.(`pathless code-change goal: file search threw on "${term}" — left unrestated`);
      return goal;
    }
    if (hits.length === 1) {
      tap?.(`pathless code-change goal — restated with target ${hits[0]} (unique hit for "${term}")`);
      return restateWithTargetFile(goal, hits[0]!);
    }
    if (hits.length > 1) {
      tap?.(`pathless code-change goal: "${term}" matched ${hits.length} files — ambiguous, trying next term`);
    }
  }

  // LAST RESORT: symbol-name matching, only once every phrase has failed.
  //
  // Phrase search compares goal text to file text, and a symptom-described goal
  // shares no text with the code that causes it (measured: 0 files for every
  // phrase, in the very repo that owns the bug). Symbol names are the one place
  // the two vocabularies meet — TimestampSchema is timestamp + schema, and the
  // goal says both words.
  //
  // Ordered after phrases and gated on symbolSearch being supplied, so a caller
  // that has not opted in keeps exactly today's behaviour. Still fail-closed:
  // EXACTLY ONE file, or the goal is returned untouched.
  if (symbolSearch) {
    const words = symbolCandidatesFromGoal(goal);
    for (const word of words) {
      let hits: readonly string[];
      try {
        hits = await symbolSearch(word, vessel);
      } catch {
        tap?.(`pathless code-change goal: symbol search threw on "${word}" — left unrestated`);
        return goal;
      }
      if (hits.length === 1) {
        tap?.(
          `pathless code-change goal — restated with target ${hits[0]} (symbol declaring "${word}"; no phrase matched)`,
        );
        return restateWithTargetFile(goal, hits[0]!);
      }
    }
    // CORROBORATION. No single word was unique, but the file that declares
    // symbols for the MOST goal words is different evidence, not a relaxation:
    // measured on the TimestampSchema goal, "timestamp" declares in 2 files and
    // "schema" in 4, and schemas.ts is the only file in both. Independent words
    // agreeing on one file is stronger than any one word alone.
    //
    // Still fail-closed twice over: the leader must match at least two words,
    // and it must be a STRICT leader — a tie is not evidence for either file.
    const tally = new Map<string, number>();
    for (const word of words) {
      let hits: readonly string[] = [];
      try {
        hits = await symbolSearch(word, vessel);
      } catch {
        return goal; // already reported above
      }
      // Cap per word: a word matching half the tree is noise, not corroboration.
      if (hits.length === 0 || hits.length > 6) continue;
      for (const h of hits) tally.set(h, (tally.get(h) ?? 0) + 1);
    }
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const [best, runnerUp] = [ranked[0], ranked[1]];
    if (best && best[1] >= 2 && (!runnerUp || runnerUp[1] < best[1])) {
      tap?.(
        `pathless code-change goal — restated with target ${best[0]} (declares symbols for ${best[1]} goal words; no phrase or single symbol matched)`,
      );
      return restateWithTargetFile(goal, best[0]);
    }
    if (words.length) {
      tap?.(`pathless code-change goal: no unique declaring file for symbols [${words.join(", ")}]`);
    }

    // PROPOSED SYMBOLS — the symptom/identifier translation, tried last.
    //
    // Only reached when every lexical route above has already failed, so it can
    // never override evidence; it can only supply words that were not in the
    // goal text. Reuses the SAME single-hit and corroboration gates, so the
    // fail-closed contract is identical.
    if (proposeSymbols) {
      let proposed: readonly string[] = [];
      try {
        proposed = await proposeSymbols(goal);
      } catch {
        tap?.(`pathless code-change goal: symbol proposal threw — left unrestated`);
        return goal;
      }
      // Never accept a word already tried, and never accept junk: an identifier
      // is word-ish and long enough to be discriminating.
      const fresh = proposed
        .map((s) => String(s).trim())
        .filter((s) => /^[A-Za-z_][A-Za-z0-9_]{3,60}$/.test(s))
        .filter((s) => !words.includes(s.toLowerCase()) && !words.includes(s))
        .slice(0, 8);
      if (fresh.length === 0) {
        tap?.(`pathless code-change goal: symbol proposal returned nothing usable — left unrestated`);
        return goal;
      }
      tap?.(`pathless code-change goal: proposed symbols [${fresh.join(", ")}] for the symptom`);
      const ptally = new Map<string, number>();
      for (const word of fresh) {
        // Try the DECLARATION search first, then the content search.
        //
        // A proposed identifier is not always a declared symbol: `goal_execution_paths`
        // is a TABLE name that only ever appears inside SQL template strings, so a
        // declaration-only lookup finds nothing even when the proposal is exactly
        // right. Falling through to the content search is what makes a correct
        // proposal actionable; both are equally fail-closed (still EXACTLY ONE file).
        let hits: readonly string[];
        try {
          hits = await symbolSearch(word, vessel);
          if (hits.length === 0) hits = await search(word, vessel);
        } catch {
          tap?.(`pathless code-change goal: symbol search threw on proposed "${word}" — left unrestated`);
          return goal;
        }
        if (hits.length === 1) {
          tap?.(
            `pathless code-change goal — restated with target ${hits[0]} (proposed symbol "${word}" declares in exactly one file)`,
          );
          return restateWithTargetFile(goal, hits[0]!);
        }
        if (hits.length === 0 || hits.length > 6) continue;
        for (const h of hits) ptally.set(h, (ptally.get(h) ?? 0) + 1);
      }
      const pranked = [...ptally.entries()].sort((a, b) => b[1] - a[1]);
      const [pbest, prunner] = [pranked[0], pranked[1]];
      if (pbest && pbest[1] >= 2 && (!prunner || prunner[1] < pbest[1])) {
        tap?.(
          `pathless code-change goal — restated with target ${pbest[0]} (declares ${pbest[1]} proposed symbols; strict leader)`,
        );
        return restateWithTargetFile(goal, pbest[0]);
      }
      tap?.(`pathless code-change goal: proposed symbols [${fresh.join(", ")}] did not single out a file`);
    }
  }
  tap?.(`pathless code-change goal: no unique file for terms [${terms.join(", ")}] — left unrestated`);
  return goal;
}
