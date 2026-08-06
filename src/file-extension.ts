/**
 * The file-extension filter a count/aggregate goal asks for.
 *
 * Extracted from index.ts so it can be tested against the REAL source rather than a
 * copy. This parse is shared by the command builders and their reach oracles, which
 * means a mistake here is INVISIBLE to grading: generator and grader agree by
 * construction, so a wrong filter produces a confidently wrong verdict in either
 * direction. Two live instances, both from this one function:
 *
 *   FALSE GREEN — "how many TypeScript files are under repos/<v>/src" parsed ext=null
 *   (only the dotted ".ts files" form was recognised), counted EVERY file, answered 18
 *   for a tree holding 17 .ts plus one .js, and the oracle alpha-credited it.
 *
 *   FALSE RED  — "Tally every TypeScript MODULE beneath repos/boredom-vessel/src"
 *   parsed ext=null because the language name had to sit next to the literal word
 *   "files". It counted all 7 files (6 .ts + 1 .json) and beta-penalised the CORRECT
 *   answer of 6. A right answer punished is worse than a wrong one credited: it
 *   poisons the posterior of the very composition the walk should be reusing.
 *
 * A goal must not have to be reworded into the parser's vocabulary to be gradable
 * (law 13 — humans are resolvers, not preprocessors).
 */

/** LANGUAGE NAME -> file extension. People say "TypeScript files", not ".ts files". */
export const LANGUAGE_EXT: ReadonlyArray<readonly [RegExp, string]> = [
  [/\btype[-\s]?script\b/i, "ts"],
  [/\bjava[-\s]?script\b/i, "js"],
  [/\bpython\b/i, "py"],
  [/\bmarkdown\b/i, "md"],
  [/\bjson\b/i, "json"],
  [/\bya?ml\b/i, "yaml"],
  [/\bshell|\bbash\b/i, "sh"],
  [/\bsql\b/i, "sql"],
  [/\brust\b/i, "rs"],
  // "files" is NOT baked in here — parseFileExtension requires the language name to be
  // adjacent to a countable noun, which supplies that constraint for every entry.
  // Leaving it in would make this entry require the noun twice, so Go would never match.
  [/\bgo(?:lang)?\b/i, "go"],
];

/** The countable noun a language name may qualify. */
const NOUN = String.raw`(?:files?|modules?|sources?|scripts?)`;

/** The extension a count goal filters on, or null for "all files". */
export function parseFileExtension(goal: string): string | null {
  const lit = goal.match(new RegExp(String.raw`\.(\w{1,6})\s+${NOUN}\b`, "i"));
  if (lit && lit[1]) return lit[1].toLowerCase();
  for (const [re, ext] of LANGUAGE_EXT) {
    // ADJACENCY, not co-occurrence. The language name must actually QUALIFY the noun
    // (optionally through one intervening word: "TypeScript source files"), so
    // "count the files that mention TypeScript" is still not narrowed to *.ts — which
    // the previous `re.test(goal) && /\bfiles?\b/` co-occurrence test allowed whenever
    // both words appeared anywhere in the goal, however far apart.
    const body = re.source.replace(/^\\b/, "").replace(/\\b$/, "");
    if (new RegExp(String.raw`\b(?:${body})\b(?:[-\s]+\w+)?[-\s]+${NOUN}\b`, "i").test(goal)) return ext;
  }
  return null;
}
