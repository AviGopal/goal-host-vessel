export function makeProducerPickHelpers(normActivityId: (id: string) => string) {
  // Genuine-first ranking: hollow scaffolds (compose/learned/repair/proposed-pattern)
  // and cross-to bridges rank below genuine activity so the walk prefers real work.
  const isHollowScaffold = (id: string): boolean => {
    const n = normActivityId(id);
    return /^(compose-|learned-compose|proposed_pattern_authored_|repaired-)/.test(n) || /-to-/.test(n);
  };
  // Reuse bonus (evidence-gated): a scaffold that is a LEARNED pathway earns rank -1
  // (ahead of fresh derivation) only when the caller provides the walk's target
  // shapes, the candidate's outputShapes cover at least one of them, and its
  // Thompson sampledScore exceeds 0.5 — pathway reuse with marginal walking
  // instead of re-derivation, gated on earned posterior evidence. Callers that
  // pass only the candidate keep the original genuine-first behavior.
  const scaffoldRank = (
    c: { id: string; outputShapes?: string[]; sampledScore?: number },
    targetShapes?: Set<string>,
  ): number => {
    if (!isHollowScaffold(c.id)) return 0;
    if (
      targetShapes !== undefined &&
      targetShapes.size > 0 &&
      Array.isArray(c.outputShapes) &&
      c.outputShapes.some((s) => targetShapes.has(s)) &&
      typeof c.sampledScore === "number" &&
      c.sampledScore > 0.5
    ) {
      return -1;
    }
    return 1;
  };
  return { isHollowScaffold, scaffoldRank };
}
