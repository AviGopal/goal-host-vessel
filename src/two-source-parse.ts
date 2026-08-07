/**
 * Parsing a TWO-SOURCE goal: "which of A or B has more", "how many more in A than B", and
 * "the combined total across A and B".
 *
 * Extracted from index.ts so the predicate can be corpus-tested BEFORE it is dispatched.
 * index.ts boots a server on import, so every parse living there has historically been
 * verified only by dispatching against it — and this family in particular has produced two
 * confidently-wrong answers from gaps nobody could unit-test:
 *
 *  - requiring "or" silently rejected "how many more ... in A than in B", which then fell
 *    to the single-source builder and answered one directory's count as the difference;
 *  - having no way to express a SUM meant a pure combination goal fell through the same
 *    hole, and was certified as a single-source count of one operand while the shell had
 *    already produced both.
 */

/** LANGUAGE NAME -> extension, for the "TypeScript files" phrasings these goals use. */
export const LANG_EXT: Record<string, string> = {
  typescript: "ts", javascript: "js", python: "py", markdown: "md",
  json: "json", rust: "rs", go: "go", shell: "sh", bash: "sh",
};

export interface TwoSrcParse { op: "total_lines" | "file_count"; relA: string; relB: string; ext: string | null; output: "which_diff" | "winner_value" | "combined"; dir: "more" | "fewer" }
export function parseTwoSourceCompare(goal: string): TwoSrcParse | null {
  const paths = [...goal.matchAll(/repos\/[\w.-]+\/[\w./-]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ""));
  const uniq = [...new Set(paths)].filter((p) => !/\.\w{1,6}$/.test(p));
  if (uniq.length !== 2) return null;                         // needs EXACTLY two distinct dir roots
  // Accept "than" as well as "or". The comparative arrives in two common phrasings —
  // "which has more, A or B?" and "how many more ... in A than in B?" — and requiring "or"
  // silently rejected the second. Measured 2026-08-06 with a precomputed oracle: the goal
  // "How many more TypeScript files are under repos/concept-db/src than under
  // repos/boredom-vessel/src?" (true answer 25 = 31 - 6) was declined here, fell through to
  // buildFromClassRow — which runs FIRST in the chain at :4447 — and was answered as a plain
  // single-directory count of 31. The walk then graded it REACHED, because
  // verifyCountFilesReach shares that builder's parse, so a wrong answer of the right SHAPE is
  // confirmed by construction. A phrasing gap in this predicate became a confidently wrong
  // answer to a harder goal.
  const _comparative = /\bor\b|\bthan\b/i.test(goal);
  // DECLINE A GOAL THIS BUILDER CANNOT FULLY SATISFY. The parse emits exactly two shapes,
  // which_diff and winner_value; neither carries an aggregate ACROSS the two sources. A goal
  // that also asks for a combined total therefore gets answered in one conjunct and — because
  // verifyTwoSourceCompareReach checks only the winner and the difference this same builder
  // produced — is certified reached with the other conjunct silently missing. Measured
  // 2026-08-06 against a precomputed oracle: "Which has more TypeScript files,
  // repos/discovery-vessel/src or repos/llm-resolver-vessel/src, and what is the combined
  // total across both directories?" (7 and 2, total 9) answered "discovery-vessel: 5" — the
  // winner and the DIFFERENCE — and was alpha-credited as a substance-honest reach.
  //
  // This is the self-confirming oracle on a second axis. The 'or'/'than' gap above was builder
  // and verifier sharing a PARSE; this is a verifier validating the SUB-GOAL THE BUILDER CHOSE
  // rather than the goal that was asked, so fixing the parse did not touch it. Declining hands
  // the goal to a builder that can carry both conjuncts, or to the walk — an honest miss the
  // learner can grade, which a partial answer wearing a reach verdict is not.
  //
  // Deliberately narrow: it requires a marker of an aggregate over BOTH sources, so the
  // comparative phrasings this predicate exists to serve are untouched. Corpus-checked before
  // dispatch against live family goals — "…and by how many?", "How many more … than …?",
  // "Which has more total lines, A or B?" and "How many total lines are under X?" all still
  // parse. `\band (?:the )?total\b` requires 'and' immediately before 'total', so the
  // comparator phrase "more total lines" is not a match.
  const _combined = /\bcombined\b|\baltogether\b|\bacross both\b|\bsum of both\b|\band (?:the )?total\b|\btotal (?:across|of) both\b/i.test(goal);
  // COMPARE + COMBINED still declines, for the reason above: this builder emits one value
  // and would answer a single conjunct while the verifier certified it.
  //
  // A PURE combination is different, and used to fall through this same return into the
  // SINGLE-SOURCE count builder, which answered one of the two operands and graded itself
  // reached on it. Measured live (dispatch d6153937): "the combined number of TypeScript
  // modules across repos/boredom-vessel/src and repos/llm-resolver-vessel/src" produced the
  // shell output "6\n2\n" — BOTH operands, correct — and was certified as
  // "verified-file-count — counted 6 .ts file(s) in repos/boredom-vessel/src". The right
  // operands were in hand and the question asked was never answered, because nothing in the
  // chain could express a sum. The comparative gate hid it: with no "or"/"than", this parse
  // declined and the single-source verifier inherited a goal it cannot represent.
  if (_combined && _comparative) return null;
  if (!_combined && !_comparative) return null;
  const more = /\bmore\b|\bmost\b|\blarger\b|\bbigger\b|\bgreater\b/i.test(goal);
  const fewer = /\bfewer\b|\bfewest\b|\bless\b|\bsmaller\b|\bsmallest\b/i.test(goal);
  if (!_combined && more === fewer) return null;               // ambiguous comparator (a sum needs none)
  const op: "total_lines" | "file_count" = /\blines?\b/i.test(goal) ? "total_lines" : "file_count";
  const output: "which_diff" | "winner_value" | "combined" = _combined
    ? "combined"
    : (/\bwhichever\b|\bhow many\b.*\bhas\b|\bin the\b/i.test(goal) && !/\bhow many more\b|\bby how (?:much|many)\b/i.test(goal) ? "winner_value" : "which_diff");
  const extLit = goal.match(/\.(\w{1,6})\s+files?\b/i);
  const extLang = goal.match(/\b(typescript|javascript|python|markdown|json|rust|go|shell|bash)\b/i);
  const ext = extLit ? extLit[1]!.toLowerCase() : extLang ? (LANG_EXT[extLang[1]!.toLowerCase()] ?? null) : null;
  return { op, relA: uniq[0]!, relB: uniq[1]!, ext, output, dir: more ? "more" : "fewer" };
}
