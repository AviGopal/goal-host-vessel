// FETCHED-VALUE STEP — turning a value the LLM extracted from a FETCHED body into the
// executor's result.
//
// The walk's executor correction loop (index.ts) has, in hand, the raw stdout of a command
// that fetched an API or web response but never parsed the answer out of it. It asks the LLM
// for ONLY the value, and accepts the answer only if it occurs verbatim in the fetched bytes.
//
// Extracted from index.ts so the step can be exercised without starting the server.

/** What the walk should do with an LLM extraction from a fetched body. */
export type FetchedValueStep =
  | { kind: "rejected"; value: string; reason: "implausible" | "not_verbatim" }
  | { kind: "command"; value: string; command: string };

/**
 * Plan the step: reduce the LLM's answer to a single token, check it is plausible and occurs
 * verbatim in the fetched body, and produce the command that binds it as the result.
 */
export function planFetchedValueStep(llmText: string, fetchedBody: string): FetchedValueStep {
  const value = String(llmText).replace(/^[\s"'`]+|[\s"'`]+$/g, "").split(/\s+/)[0] ?? "";
  const plausible = value.length > 0 && value !== "NONE" && /\d/.test(value) && value.length <= 40;
  if (!plausible) return { kind: "rejected", value, reason: "implausible" };
  if (!fetchedBody.includes(value)) return { kind: "rejected", value, reason: "not_verbatim" };
  return { kind: "command", value, command: `echo ${JSON.stringify(value)}` };
}

/**
 * May the fetch half of a failed pipeline (`curl … | jq …` → `curl …`) be re-run on its own to
 * recover the body the parser ate? Only a lone curl/wget with no operator outside quotes.
 */
export function fetchPrefixIsReRunnable(fetchPart: string): boolean {
  const unquoted = fetchPart.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  return /^(curl|wget)\b/.test(fetchPart) && !/[;&>|]|\$\(|`/.test(unquoted);
}
