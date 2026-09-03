/**
 * BIND ARGUMENTS FROM THE POOL, BEFORE ASKING AN LLM TO INVENT THEM.
 *
 * The operator's diagnosis, 2026-09-03: "we are not threading impulse content through the
 * activities in an effective way — impulses have varied content but they can be treated
 * similarly to variables."
 *
 * Measured before writing this. Argument synthesis DOES receive the pool, but as truncated
 * prose for a model to retype: `priorFindings` renders each impulse as
 * `- <shape>: <content sliced to 800 chars>`, filters terminal shapes OUT, and sits inside a
 * block whose bulk warns the model NOT to use prior findings as an answer. The deterministic
 * reference mechanism that would actually thread — `{{shape}}` / `{{shape.field}}`,
 * interpolated from the pool and shell-quoted — exists and has ZERO uses in the entire
 * retained journal. So an operand that is already an impulse gets re-derived by an LLM, and
 * when that misses, the resolver answers "X is required": since 2026-09-01, 12 of 41 produced
 * shapes (29%) carried an error body, every one of that form.
 *
 * Two worked cases from the same day: a goal about Iceland's population invoked a code-search
 * activity that returned {"error":"path and name are required"}; a goal about melting points
 * produced shellResult {"error":"command is required"} WHILE THE ANSWER SAT IN AN
 * ALREADY-PRODUCED webSearchResult IN THE SAME POOL.
 *
 * This binds what the pool can supply so the model is asked only for what it cannot.
 *
 * DELIBERATELY CONSERVATIVE — a wrong bind is worse than no bind, because it would be
 * invisible where a missing field is loud:
 *   - only fields the resolver DECLARES as required are bound;
 *   - only PRIMITIVE values (string/number/boolean) — never an object or array, which would
 *     smuggle a whole impulse into a scalar argument;
 *   - only when the pool agrees UNAMBIGUOUSLY: if two impulses offer different values for the
 *     same field name, bind nothing and let synthesis decide;
 *   - empty strings are not values.
 * If nothing binds, behaviour is exactly as before.
 */

export interface PoolLike {
  content?: unknown;
  metadata?: unknown;
}

/** The bound value plus where it came from, so provenance can be logged and measured. */
export interface BoundArg {
  value: string | number | boolean;
  fromShape: string;
}

function shapeOf(imp: PoolLike): string {
  const m = imp.metadata as { shape?: unknown } | undefined;
  return typeof m?.shape === "string" ? m.shape : "?";
}

/** Parse an impulse's content into an object, tolerating a JSON string body. */
function contentObject(imp: PoolLike): Record<string, unknown> | null {
  let c: unknown = imp.content;
  if (typeof c === "string") {
    const s = c.trim();
    if (!s.startsWith("{")) return null;
    try { c = JSON.parse(s); } catch { return null; }
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  return c as Record<string, unknown>;
}

function isBindable(v: unknown): v is string | number | boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "boolean") return true;
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * For each required field, bind a value the pool unambiguously supplies.
 * Returns only the fields it could bind; callers merge synthesis over the remainder.
 */
export function bindArgsFromPool(
  requiredFields: readonly string[],
  pool: readonly PoolLike[],
): Record<string, BoundArg> {
  const out: Record<string, BoundArg> = {};
  if (!Array.isArray(requiredFields) || requiredFields.length === 0) return out;
  if (!Array.isArray(pool) || pool.length === 0) return out;

  for (const field of requiredFields) {
    if (typeof field !== "string" || field.length === 0) continue;
    const candidates: BoundArg[] = [];
    for (const imp of pool) {
      const obj = contentObject(imp);
      if (!obj || !(field in obj)) continue;
      const v = obj[field];
      if (!isBindable(v)) continue;
      candidates.push({ value: v, fromShape: shapeOf(imp) });
    }
    if (candidates.length === 0) continue;
    // Unambiguous only: every candidate must agree on the value.
    const first = candidates[0]!;
    const allAgree = candidates.every((c) => c.value === first.value);
    if (allAgree) out[field] = first;
  }
  return out;
}

/** Drop provenance for the call site, keeping only the values. */
export function boundValues(bound: Record<string, BoundArg>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bound)) out[k] = v.value;
  return out;
}

/** One-line provenance for the journal, so the bind rate becomes measurable. */
export function describeBindings(bound: Record<string, BoundArg>): string {
  const entries = Object.entries(bound);
  if (entries.length === 0) return "none";
  return entries.map(([k, v]) => `${k}<-${v.fromShape}`).join(", ");
}
