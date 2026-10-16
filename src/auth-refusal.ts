/**
 * AN AUTH REFUSAL CARRIED AS CONTENT (REACHABILITY c, qa amendment after node1's transport unmask, 2026-10-16 23:00Z).
 *
 * An enforcing hub answers a node-issued credential with a 200 whose body is an error envelope, e.g.
 * `{"content":{"error":"unauthorized","shape":"llm_completion_dispatch","reason":"absent","note":"this shape requires a
 * caller credential identity validates"}}`. Measured (dispatch c02fcc77): the walk pooled that envelope as a HOLLOW
 * answer under the target shape and judged it, instead of falling back to the local producer.
 *
 * Read from the answer's own structured fields (error / code / failure_mode at the top level, or under content / body),
 * matched against the auth codes the fleet's auth layers emit; never from prose. The same rule as activity-api's
 * replication tick (isAuthRefusalBody, part d).
 */
const AUTH_CODES = new Set(["unauthorized", "UNAUTHORIZED", "forbidden", "FORBIDDEN", "INVALID_API_KEY", "caller_credential_required"]);

function codesOf(o: unknown): unknown[] {
  if (!o || typeof o !== "object") return [];
  const r = o as Record<string, unknown>;
  const e = r["error"];
  return [e, (e && typeof e === "object" ? (e as Record<string, unknown>)["code"] : undefined), r["code"], r["failure_mode"]];
}

/** The auth code an answer carries, or null. */
export function authRefusalCode(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  for (const c of [...codesOf(r), ...codesOf(r["content"]), ...codesOf(r["body"])]) {
    if (typeof c === "string" && AUTH_CODES.has(c)) return c;
  }
  return null;
}
