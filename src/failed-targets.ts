/**
 * WHICH TARGETS A RETRY MUST NOT CHOOSE AGAIN (CHANGE-35 / A2b-minimal, repaired). Given the goal's exact failure records
 * since its last reach, the targets of the UNBROKEN RUN of latest GRADED misses (GRADED_VERDICT_REASON, below): attempt 3
 * after X then Y failed avoids both. A newer failure that is not a verdict ends the run (nothing was judged about the
 * targets); a reach since has already removed the older records (recallGoalFailures).
 * The first version used only the LATEST failure, so a third attempt went back to the first failed target. The second
 * continued only over "no artifact on the target" (NO_ARTIFACT_REASON), so two misses graded by any other class on X
 * left the third attempt free to choose X again (REALIGNMENT R:181).
 */
export interface FailedTargetRecord { at: string; reason: string; targets?: string[] }

// The floor supersedes the dispatch's reason with its own wrapper (index.ts: `floor ${reason_code}: ${verdict.reason}`);
// when the floor ran only because the walk had not reached, that wrapper carries the walk's no-artifact verdict. Still
// anchored: a reason that merely MENTIONS the class elsewhere is not one.
export const NO_ARTIFACT_REASON = /^(?:floor floor:upstream-not-reached: )?deterministic:write-goal-no-artifact\b/;

export function targetsToAvoid(exact: readonly FailedTargetRecord[]): string[] {
  const out: string[] = [];
  for (const r of [...exact].sort((a, b) => b.at.localeCompare(a.at))) {
    if (!GRADED_VERDICT_REASON.test(r.reason)) break;
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

/** A graded verdict's reason: it opens with its verdict class (`deterministic:<class>`), bare or behind the floor's
 *  wrapper (`floor <reason_code>: `, index.ts). Anchored like NO_ARTIFACT_REASON. */
export const GRADED_VERDICT_REASON = /^(?:floor [\w:-]+: )?deterministic:[\w-]+/;

/**
 * WHETHER A FAILURE IS ABOUT THE PRODUCED CONTENT. Structural terminations and environment faults (no producer, a
 * capacity or transport fault, an HTTP 5xx from a vessel, an abstain) carry no correctable content: they are not kept in
 * the failure memory, and they do not invalidate the goal's memoised target routes (the same targets are still the
 * right ones once the fault clears). A content failure does both: the routes are asked again on the next dispatch,
 * instead of replaying the single set they proposed before.
 */
export function failureInvalidatesTargetMemo(reason: string | null | undefined): boolean {
  const r = String(reason ?? "").trim();
  if (!r) return false;
  if (/^abstain:/i.test(r)) return false;
  if (/no pick|no producer|no template produces|capability gap filed|missing shapes|constructible payload|terminating walk|hollow_walklog_capped|verdict unknown|verdict=unknown|capacity|econnrefused|unreachable|timed out/i.test(r)) return false;
  // An HTTP 5xx is a transport outcome only where a call reported it. A graded verdict (GRADED_VERDICT_REASON) is about the
  // content whatever its prose quotes ("the answer says fs_edit returned HTTP 500"), as transient-failure.ts lets a known
  // status, not the text, decide: the 5xx test reads only a reason that is not a verdict.
  return GRADED_VERDICT_REASON.test(r) || !/\bHTTP 5\d\d\b/i.test(r);
}

