// FETCHED-VALUE STEP — turning a value the LLM extracted from a FETCHED body into the
// executor's result.
//
// The walk's executor correction loop (index.ts) has, in hand, the raw stdout of a command
// that fetched an API or web response but never parsed the answer out of it. It asks the LLM
// for ONLY the value, and accepts the answer only if it occurs verbatim in the fetched bytes.
//
// FETCHED TEXT NEVER REACHES A SHELL. This step used to bind the value as `echo "<value>"` and
// run it through the shell resolver. `$(` and backticks execute inside double quotes, so a body
// carrying `$(touch${IFS}x)1` passed every check below and ran as root in the container: any web
// page the walk fetched could execute code. A shell is never needed to PRODUCE a value that is
// already in hand, so the result is built directly as the executor's result impulse — the same
// {stdout, stderr, exit_code} a shell resolver returns — and no command is emitted at all.
//
// The strict charset is defence in depth, not the fix: the value lands in the pool, and a later
// executor command may splice it in through a {{shape}} placeholder an LLM wrapped in double
// quotes. A numeric answer never needs anything outside [-+0-9.,eE%].
//
// Extracted from index.ts so the step can be exercised without starting the server.

/** The only characters an extracted value may contain. */
export const STRICT_VALUE_CHARSET = /^[-+0-9.,eE%]+$/;

/** The executor result built directly from an extracted value — same fields a shell returns. */
export interface FetchedValueImpulse {
  shape: string;
  stdout: string;
  stderr: string;
  exit_code: 0;
  provenance: "extracted-verbatim-from-fetched-body";
}

/** What the walk should do with an LLM extraction from a fetched body. */
export type FetchedValueStep =
  | { kind: "rejected"; value: string; reason: "implausible" | "not_verbatim" | "charset" }
  | { kind: "impulse"; value: string; impulse: FetchedValueImpulse };

/**
 * Plan the step: reduce the LLM's answer to a single token, check it is plausible, inside the
 * strict value charset, and verbatim in the fetched body, and build the result impulse from it.
 */
export function planFetchedValueStep(llmText: string, fetchedBody: string, shape = "shellResult"): FetchedValueStep {
  const value = String(llmText).replace(/^[\s"'`]+|[\s"'`]+$/g, "").split(/\s+/)[0] ?? "";
  const plausible = value.length > 0 && value !== "NONE" && /\d/.test(value) && value.length <= 40;
  if (!plausible) return { kind: "rejected", value, reason: "implausible" };
  if (!STRICT_VALUE_CHARSET.test(value)) return { kind: "rejected", value, reason: "charset" };
  if (!fetchedBody.includes(value)) return { kind: "rejected", value, reason: "not_verbatim" };
  return {
    kind: "impulse",
    value,
    impulse: { shape, stdout: `${value}\n`, stderr: "", exit_code: 0, provenance: "extracted-verbatim-from-fetched-body" },
  };
}

/**
 * May the fetch half of a failed pipeline (`curl … | jq …` → `curl …`) be re-run on its own to
 * recover the body the parser ate? Only a lone curl/wget with no operator outside quotes, and no
 * command substitution anywhere the shell evaluates it.
 *
 * Operators (`; & > |`) are looked for after BOTH quote kinds are blanked — a URL's `&` inside
 * quotes is harmless. Command substitution (`$(`, backtick) is looked for after blanking only
 * SINGLE-quoted spans, because it executes inside double quotes.
 */
export function fetchPrefixIsReRunnable(fetchPart: string): boolean {
  const outsideSingle = fetchPart.replace(/'[^']*'/g, "''");
  const unquoted = outsideSingle.replace(/"[^"]*"/g, '""');
  return /^(curl|wget)\b/.test(fetchPart) && !/[;&>|]/.test(unquoted) && !/\$\(|`/.test(outsideSingle);
}
