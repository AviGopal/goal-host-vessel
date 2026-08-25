import { describe, expect, test } from "bun:test";

describe("reach-hole-detector", () => {
  const classifyNonReach = (reason: string) => {
    const lower = reason.toLowerCase();
    if (["grounding window", "no template produces", "refused blind", "capability gap", "busy"]
      .some(x => lower.includes(x))) return "structural-refuse";
    if (["verify failed", "typecheck", "ts2307", "semantic", "no-op", "identical"]
      .some(x => lower.includes(x))) return "content-failure";
    return "other";
  };

  const detectStructuralHoles = (records: Array<{category: string, reached: boolean, reason: string}>) => {
    const byCategory = new Map<string, {total: number, reached: number, structuralRefuse: number}>();
    for (const {category, reached, reason} of records) {
      const entry = byCategory.get(category) ?? {total: 0, reached: 0, structuralRefuse: 0};
      entry.total++;
      entry.reached += reached ? 1 : 0;
      if (!reached && classifyNonReach(reason) === 'structural-refuse') entry.structuralRefuse++;
      byCategory.set(category, entry);
    }

    return Array.from(byCategory.entries()).map(([category, {total, reached, structuralRefuse}]) => {
      const reachRate = reached / total;
      const unreached = total - reached;
      const structuralFraction = unreached > 0 ? structuralRefuse / unreached : 0;
      return {
        category,
        total,
        reachRate,
        structuralFraction,
        isStructuralHole: reachRate <= 0.1 && structuralFraction >= 0.5
      };
    });
  };

  test("classifyNonReach categorizes structural refuses", () => {
    expect(classifyNonReach('grounding window contains none of the target files'))
      .toBe('structural-refuse');
  });

  test("classifyNonReach categorizes content failures", () => {
    expect(classifyNonReach('verify failed: TS2307 module has no exported member'))
      .toBe('content-failure');
  });

  test("classifyNonReach categorizes other reasons", () => {
    expect(classifyNonReach('completed and reached')).toBe('other');
  });

  test("detectStructuralHoles identifies structural holes", () => {
    const records = [
      {category: 'A', reached: false, reason: 'capability gap in template'},
      {category: 'A', reached: false, reason: 'busy executing other tasks'},
      {category: 'A', reached: false, reason: 'refused blind attempt'},
      {category: 'A', reached: false, reason: 'no template produces this shape'},
    ];
    const result = detectStructuralHoles(records);
    expect(result).toEqual([{
      category: 'A',
      total: 4,
      reachRate: 0,
      structuralFraction: 1,
      isStructuralHole: true
    }]);
  });
});
