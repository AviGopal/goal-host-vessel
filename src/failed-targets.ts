/**
 * WHICH TARGETS A RETRY MUST NOT CHOOSE AGAIN (CHANGE-35 / A2b-minimal, repaired). Given the goal's exact failure records
 * since its last reach, the targets of the UNBROKEN RUN of latest "no artifact on the target" (write-goal-no-artifact)
 * failures: attempt 3 after X then Y failed avoids both. A newer failure of any other kind ends the run (its lesson is
 * not "wrong target"); a reach since has already removed the older records (recallGoalFailures).
 * The first version used only the LATEST failure, so a third attempt went back to the first failed target.
 */
export interface FailedTargetRecord { at: string; reason: string; targets?: string[] }

export const NO_ARTIFACT_REASON = /^deterministic:write-goal-no-artifact\b/;

export function targetsToAvoid(exact: readonly FailedTargetRecord[]): string[] {
  const out: string[] = [];
  for (const r of [...exact].sort((a, b) => b.at.localeCompare(a.at))) {
    if (!NO_ARTIFACT_REASON.test(r.reason)) break;
    for (const t of r.targets ?? []) if (!out.includes(t)) out.push(t);
  }
  return out;
}
