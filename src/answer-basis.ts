// THE HUMAN-FACING POOL DIGEST: what a person reads under an answer's "## Basis" (and a bridge note's findings).
//
// A retry or re-frame starts from the prior attempt's successful steps: their impulses are carried into the new walk's
// pool (metadata.carriedFrom), AHEAD of what the new walk produces. The digest listed the pool in order under one
// budget, so after a hollow first attempt and a reaching re-frame the person saw the hollow attempt's output first,
// and often only that, and judged the wrong content. The walk's own outputs now come first; carried ones follow
// under a label that says they came from an earlier attempt. A walk with nothing carried renders exactly as before.

type PoolImpulseLike = { metadata?: unknown; content?: unknown };

export const CARRIED_LABEL = "(carried from an earlier attempt in this dispatch)";

function rendered(imp: PoolImpulseLike, cap: number): string {
  let c: string;
  try { c = typeof imp.content === "string" ? imp.content : JSON.stringify(imp.content); } catch { c = String(imp.content); }
  if (c === undefined || c === null) c = "";
  return c.slice(0, cap);
}

/** The pool's content for a person: each impulse but the goal, capped per impulse; the walk's own first, carried after. */
export function humanPoolDigest(pool: readonly PoolImpulseLike[], cap = 1500): string {
  const meta = (imp: PoolImpulseLike) => (imp.metadata ?? {}) as { shape?: string; carriedFrom?: unknown };
  const kept = pool.filter((imp) => { const s = meta(imp).shape; return s && s !== "goal"; });
  const isCarried = (imp: PoolImpulseLike) => meta(imp).carriedFrom !== undefined;
  const own = kept.filter((imp) => !isCarried(imp)).map((imp) => rendered(imp, cap)).filter((c) => c.trim().length > 0);
  const carried = kept.filter(isCarried).map((imp) => rendered(imp, cap)).filter((c) => c.trim().length > 0);
  return carried.length === 0 ? own.join("\n\n") : [...own, CARRIED_LABEL, ...carried].join("\n\n");
}
