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
    const coversTarget =
      targetShapes !== undefined &&
      targetShapes.size > 0 &&
      Array.isArray(c.outputShapes) &&
      c.outputShapes.some((s) => targetShapes.has(s));
    // A target-covering learned scaffold IS a candidate pathway for THIS goal:
    //   proven reuse (sampledScore > 0.5) -> rank -1, sorts ahead of fresh derivation;
    //   cold / unproven / no score yet    -> rank 0, FAIR competition with genuine
    //     producers (stable sort keeps discovery-ranked genuine producers ahead)
    //     instead of rank-1 relegation, which the single-pick SKIPS outright for a
    //     bridgeable target -> a cold composite could never be SELECTED, so never earned
    //     a posterior, so reuse never bootstrapped. Relevance + feasibility are enforced
    //     SEPARATELY by feasibleProducer (isIrrelevantLearnedComposite + inputsSatisfied);
    //     scaffoldRank only ORDERS. Non-target-covering scaffolds stay rank 1 (genuine-first).
    if (!coversTarget) return 1;
    if (typeof c.sampledScore === "number" && c.sampledScore > 0.5) return -1;
    return 0;
  };
  return { isHollowScaffold, scaffoldRank };
}
