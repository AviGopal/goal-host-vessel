/**
 * Is a resolver body an EMPTY STORE LISTING rather than a produced artifact?
 *
 * THE DEFECT THIS CLOSES. The vessel-resolve satisfier asks a connected vessel
 * for a missing shape. For shapes that activity-api also STORES, a bare resolve
 * is answered by the store's LIST endpoint:
 *
 *   {"success":true,
 *    "content":"{\"total\":0,\"offset\":0,\"limit\":100,\"entries\":[]}",
 *    "metadata":{"shape":"code_modification_proposal","rowCount":0,
 *                "summary":"0 code_modification_proposal rows"}}
 *
 * That is a QUERY MISS — "the store holds none of these" — but every existing
 * guard waves it through: `rawResolve` only rejects `success === false`, and the
 * body-honesty check sees `success: true` plus a non-empty `content` string. So
 * the walk records the shape as PRODUCED, and the consuming step then fails with
 * "no constructible payload" because there is nothing to consume.
 *
 * Observed end to end on an edit goal: target inference correctly chose
 * `code_modification_proposal` + `_write`, the satisfier "produced" the proposal
 * from this empty listing, and `_write` then had no `proposalData`. The real
 * drafter (`feature_compose`, live on development-vessel) was never reached,
 * because the shape already looked satisfied.
 *
 * A prior session flagged exactly this route as "the unfound blocker" and left
 * an instruction not to re-derive it from code paths but to fetch the body the
 * satisfier actually receives. This module encodes that body.
 *
 * ── DELIBERATELY NARROW ──────────────────────────────────────────────────────
 * "Zero results" is a perfectly good ANSWER for a counting or search goal, and
 * refusing those would be a worse regression than the bug. So this matches only
 * the unmistakable store-listing envelope: an empty `entries` array carried
 * alongside pagination keys, or an explicit zero `rowCount`. A body like
 * `{count: 0, files: []}` — what a legitimate counting goal produces — is NOT
 * matched.
 */

/** Keys that mark a paginated store listing rather than a computed result. */
const PAGINATION_KEYS = ["total", "offset", "limit"] as const;

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const s = value.trim();
    if (!s.startsWith("{") && !s.startsWith("[")) return null;
    try {
      const parsed: unknown = JSON.parse(s);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * @returns a human-readable reason when the body is an empty store listing, or
 *          `null` when it is anything else (including a legitimate empty answer).
 */
export function emptyResultSetReason(body: unknown, metadata?: unknown): string | null {
  const meta = asObject(metadata);

  // Explicit row accounting is the strongest signal and needs no parsing of the
  // payload: the store itself is reporting how many rows it returned.
  if (meta && typeof meta.rowCount === "number" && meta.rowCount === 0) {
    const shape = typeof meta.shape === "string" ? meta.shape : "the shape";
    return `the resolver returned an EMPTY STORE LISTING for ${shape} (rowCount 0) — that is a query miss, not a produced artifact`;
  }

  const obj = asObject(body) ?? asObject((asObject(body) ?? {}).content);
  if (!obj) return null;

  // Unwrap one common envelope level: {content: "<json>"} / {body: {...}}.
  const inner = asObject(obj.content) ?? asObject(obj.body) ?? obj;

  const entries = inner.entries;
  if (!Array.isArray(entries) || entries.length > 0) return null;

  const hasPagination = PAGINATION_KEYS.some((k) => k in inner);
  if (!hasPagination) return null;

  // `total` is authoritative when present: a non-zero total with an empty page
  // means the caller paged past the end, which is a different (and rarer) bug —
  // still not a production, but say so accurately.
  const total = typeof inner.total === "number" ? inner.total : null;
  return total !== null && total > 0
    ? `the resolver returned an EMPTY PAGE of a ${total}-row listing — no artifact was produced`
    : `the resolver returned an EMPTY STORE LISTING (0 rows) — that is a query miss, not a produced artifact`;
}
