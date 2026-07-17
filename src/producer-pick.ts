export function makeProducerPickHelpers(normActivityId: (id: string) => string) {
  // Genuine-first ranking: hollow scaffolds (compose/learned/repair/proposed-pattern)
  // and cross-to bridges rank below genuine activity so the walk prefers real work.
  const isHollowScaffold = (id: string): boolean => {
    const n = normActivityId(id);
    return /^(compose-|learned-compose|proposed_pattern_authored_|repaired-)/.test(n) || /-to-/.test(n);
  };
  const scaffoldRank = (c: { id: string }): number => (isHollowScaffold(c.id) ? 1 : 0);
  return { isHollowScaffold, scaffoldRank };
}
