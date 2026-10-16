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

/**
 * J4: A RETRY AFTER A JUDGE-GRADED MISS ADAPTS. Target selection (A2b-proper, selectTargetSet) reads the goal class's
 * recorded paths, but a probe runs with learningMode "observe", where no path is recorded: attempt 2 re-ran attempt 1's
 * inference and chose the same targets. The failure memory is kept in every mode, so its records since the goal's last
 * reach are offered to the selection as rows of the targets each failed under ({targets} failed once). The caller passes
 * them ONLY when paths are not being recorded (observe): with learning on, the posterior already holds every attempt's
 * row, and adding these would count the same miss twice. No new constant: Beta(1+s, 1+f) does the down-weighting.
 */
export function failureRowsFrom(exact: readonly FailedTargetRecord[]): Array<{ expected_output_shapes: string[]; successful_executions: number; failed_executions: number }> {
  return exact.filter((r) => Array.isArray(r.targets) && r.targets.length > 0).map((r) => ({ expected_output_shapes: [...r.targets!], successful_executions: 0, failed_executions: 1 }));
}
