/**
 * J3: WHICH ALTERNATIVE FRAMINGS A HOLLOW WALK RE-TRIES, AND IN WHAT ORDER (user ruling 2026-10-16T22:56:41Z).
 * Every non-empty alternative that differs from the framing just tried, in the decision's OWN order (A2b-proper's
 * posterior draw order; inference's order when cold), bounded by the dispatch's own maxAttempts. The reframe used to try
 * only the FIRST differing alternative, once (b416bf0, 07-14), so a second framing that would reach (RUN 1R: web_search)
 * never ran. Pure: the walk loops over the result through its existing acceptance.
 */
export function reframeCandidates(alternatives: unknown, current: readonly string[], maxAttempts: number): string[][] {
  if (!Array.isArray(alternatives)) return [];
  const same = (a: readonly string[]) => a.length === current.length && a.every((s, i) => s === current[i]);
  return (alternatives as unknown[])
    .filter((a): a is string[] => Array.isArray(a) && a.length > 0 && !same(a as string[]))
    .slice(0, Math.max(1, Math.floor(Number.isFinite(maxAttempts) ? maxAttempts : 1)));
}
