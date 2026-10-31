/**
 * THE SECRET-EXTRACTION PREDICATE (index.ts: the walk's pre-execution refusal and the /run-goal handler-entry refusal).
 * A goal is refused when it asks to REPORT/PRINT/REVEAL a secret VALUE, and is not refused when it asks only for a
 * secret's non-value metadata (length / presence / hash / fingerprint).
 *
 * The rule reads the whole goal: an ask word anywhere plus a secret word anywhere refuses it. ONE kind of goal is judged
 * more narrowly: the check-supply goal (development-vessel gap-check-supply.ts checkSupplyGoalText and
 * check-supply-admission.ts configSiteCheckGoal), recognised by its structure, its lead "Write ONE failing test in
 * repos/<vessel>/test/checks/" and its closing "Do not change src/ or any other file.". Such a goal quotes its gap's own
 * prose: one gap listed a module named "password" in its symptom while its control was the question "What is 4 + 5?",
 * and the goal, which asks for no secret, was refused. In a check goal an ask and a secret word refuse only within two
 * adjacent sentences (either order, so "a password question. What is it?" still refuses).
 * A goal that carries a secret-shaped VALUE anywhere (a key, a bearer token, a JWT, a KEY=value assignment) is judged
 * by the whole-goal rule whatever its kind, so quoting or splitting text never lets a value through.
 * Known limit: a hostile goal can mimic the check-goal lead; that is acceptable only because check goals are
 * system-authored, and the value guard still applies.
 */
import { scrubReason } from "./route-around";

const ASKS_VALUE = /\b(report|print|show|reveal|extract|echo|display|leak|dump|output|tell me|what(?:'s| is)|value of|get me|give me|expose)\b/;
const NAMES_SECRET = /\b(api[_ ]?key|access[_ ]?token|private[_ ]?key|client[_ ]?secret|passphrase|password|[a-z0-9]+_(?:key|secret|token|password|passphrase)|anthropic_api_key|openai_api_key|jwt_secret|surrealdb_password|\bcredentials?\b)\b/;
const META_NOT_VALUE = /\b(length|how long|number of characters|char count|presence|whether .* (?:is )?set|is .* set|exists|does .* exist|hash|sha|fingerprint|last \d|first \d|redact|masked?)\b/;
/** Secret-shaped values scrubReason does not already redact: provider keys, cloud key ids, PEM private keys, `password: …`. */
const VALUE_SHAPED = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:api[_-]?key|password|passphrase|secret|token)\s*[:=]\s*["']?[^\s"']{8,}/i;
/** The check-supply goal's structure: both of development-vessel's check-goal builders write exactly these. */
const CHECK_GOAL_LEAD = /^Write ONE failing test in repos\/[^\s/]+\/test\/checks\//;
const CHECK_GOAL_CLOSE = "Do not change src/ or any other file.";

/** True when the text carries something shaped like a secret value (not merely a secret's name). */
export function carriesSecretValue(text: string): boolean {
  return VALUE_SHAPED.test(text) || scrubReason(text) !== text;
}

/** True for a check-supply test-writing goal, by structure: its lead AND its closing clause. */
export function isCheckSupplyGoal(goal: string): boolean {
  return CHECK_GOAL_LEAD.test(goal.trimStart()) && goal.includes(CHECK_GOAL_CLOSE);
}

/** The goal's sentences: split at . ! ? followed by whitespace, a closing mark or the end, and at line breaks. */
export function goalSentences(lowered: string): string[] {
  return lowered.split(/[.!?]+(?=[\s)"'`\]]|$)|\n+/).filter((s) => s.trim().length > 0);
}

/** True when the goal asks to reveal a secret/credential VALUE (index.ts refuses it before anything runs). */
export function asksForSecretValue(goal: string): boolean {
  const g = goal.toLowerCase();
  const wholeGoal = ASKS_VALUE.test(g) && NAMES_SECRET.test(g) && !META_NOT_VALUE.test(g);
  if (!wholeGoal || !isCheckSupplyGoal(goal) || carriesSecretValue(goal)) return wholeGoal;
  // A check goal: an ask and a secret word within one sentence or two adjacent ones.
  const s = goalSentences(g);
  return s.some((x, i) => {
    const pair = i + 1 < s.length ? `${x} ${s[i + 1]}` : x;
    return ASKS_VALUE.test(pair) && NAMES_SECRET.test(pair);
  });
}
