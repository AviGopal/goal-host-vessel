/**
 * ORACLE ABSTAINS ARE COUNTED, PER FAMILY (2026-10-10).
 *
 * A deterministic oracle that abstains hands the goal to the next grader. That is the honest move when its
 * observation is unavailable ("an unavailable observation never becomes a negative outcome"), but an oracle
 * that abstains on most of the class it claims has stopped observing that class, and an abstain is silent:
 * nothing failed, so nothing is filed. The code-investigation citation oracle had the opposite defect — it
 * returned a deterministic not-reached where it should have abstained — and the fix for that must not trade a
 * loud wrong verdict for a silent missing one.
 *
 * So every decision an oracle family makes is tallied here:
 *   - a log line per abstain (the caller prints it, with the family, the reason and the goal hash);
 *   - running counters (decisions, verdicts, abstains, not-applicable) per family;
 *   - a COUNTERWEIGHT: over the last `window` APPLICABLE decisions, an abstain share above `share` logs a
 *     DIVERGENCE line. Not-applicable abstains are counted but kept out of the share: a goal outside the
 *     family's class is not the oracle failing to observe its class.
 * The thresholds are read by the caller from the shaped selection tuning (selection-tuning.ts) at use time.
 */

export type OracleOutcome = "verdict" | "abstain" | "not-applicable";

export interface OracleFamilyCounts { decisions: number; verdicts: number; abstains: number; notApplicable: number }

export interface OracleTallyResult {
  counts: OracleFamilyCounts;
  /** Abstain share over the recent applicable window (0 when the window is empty). */
  windowShare: number;
  windowSize: number;
  /** True when this record pushed (or kept) the family above the divergence share. */
  divergent: boolean;
  /** The divergence line, when one is due (at most once per `window` applicable decisions). */
  divergenceLine: string | null;
}

export interface OracleAbstainTally {
  record(family: string, outcome: OracleOutcome, thresholds: { window: number; share: number }): OracleTallyResult;
  counts(): Record<string, OracleFamilyCounts>;
}

export function createOracleAbstainTally(): OracleAbstainTally {
  const totals = new Map<string, OracleFamilyCounts>();
  const recent = new Map<string, boolean[]>(); // true = abstain, applicable decisions only
  const sinceDivergenceLog = new Map<string, number>();
  return {
    record(family, outcome, { window, share }) {
      const c = totals.get(family) ?? { decisions: 0, verdicts: 0, abstains: 0, notApplicable: 0 };
      c.decisions++;
      if (outcome === "verdict") c.verdicts++;
      else if (outcome === "abstain") c.abstains++;
      else c.notApplicable++;
      totals.set(family, c);
      const w = Math.max(1, Math.floor(window));
      const r = recent.get(family) ?? [];
      if (outcome !== "not-applicable") {
        r.push(outcome === "abstain");
        while (r.length > w) r.shift();
        recent.set(family, r);
      }
      const abstained = r.filter(Boolean).length;
      const windowShare = r.length > 0 ? abstained / r.length : 0;
      // A full window only: three abstains out of four decisions after a restart is not a measured share.
      const divergent = r.length >= w && windowShare > share;
      const since = (sinceDivergenceLog.get(family) ?? w) + (outcome !== "not-applicable" ? 1 : 0);
      let divergenceLine: string | null = null;
      if (divergent && since >= w) {
        divergenceLine = `[oracle-abstain] DIVERGENCE family=${family} abstain_share=${windowShare.toFixed(2)} over the last ${r.length} applicable decisions exceeds ${share} — the oracle is abstaining on the class it claims, so it is not observing it (totals: decisions=${c.decisions} verdicts=${c.verdicts} abstains=${c.abstains} not_applicable=${c.notApplicable})`;
        sinceDivergenceLog.set(family, 0);
      } else {
        sinceDivergenceLog.set(family, since);
      }
      return { counts: { ...c }, windowShare, windowSize: r.length, divergent, divergenceLine };
    },
    counts() {
      return Object.fromEntries([...totals.entries()].map(([k, v]) => [k, { ...v }]));
    },
  };
}
