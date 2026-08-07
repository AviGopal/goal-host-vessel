/**
 * "How many FILES" is one question. "How many distinct file EXTENSIONS", "how many
 * SUBDIRECTORIES", "how many EXPORTS" are different questions over the same tree, and a file
 * count offered as their answer is simply wrong.
 *
 * `d7fee60` taught the ORACLE (verifyCountFilesReach) to decline these, after ext_variety
 * measured 20/20 reached and 0/20 correct across two 80-goal runs — it was the only cold family
 * that survived the no-oracle refusal, because that verifier claimed it first.
 *
 * The COMMAND BUILDER never learned the same lesson, and it gates on `\bfiles?\b` — which
 * "distinct FILE extensions" matches. So the builder still emits a plain `find | wc -l` for
 * those goals, and because that branch runs FIRST it pre-empts the reuse-cache and the lexical
 * rebind entirely (its own log line says "SKIPPED reuse-cache + pointer_arg synthesis").
 *
 * The consequence is worse than a wrong answer, and it is what a repeated-exposure run
 * exposed: the builder produces the SAME wrong command on every attempt, the oracle now
 * correctly declines it, and the goal is not-reached forever. Nothing converts a failed
 * attempt into a better later one, because the path that could have — reusing a verified
 * command from a similar goal that DID reach — is never reached. Measured across 4 identical
 * rounds: 41.7%, 41.7%, 41.7%, 50.0%. Perfectly flat, by construction.
 *
 * One rule, imported by both the builder and the oracle, so they cannot drift apart again —
 * the drift this file's neighbours warn about repeatedly and then repeat.
 */

/**
 * Does this goal count something OTHER than files, over a tree a file-count would enumerate?
 *
 * Deliberately a keyword list rather than anything cleverer: the cost of a false positive is
 * an abstention (the goal falls through to reuse, rebind, or synthesis — all of which can
 * still answer it), while the cost of a false negative is a confidently wrong number that a
 * shared parse then certifies. Those are not symmetric, so this leans toward declining.
 */
export function countsSomeOtherUnit(goal: string): boolean {
  return /\b(extensions?|sub-?directories|sub-?dirs?|directories|folders?|functions?|classes|exports?|imports?|dependencies|packages?|symbols?|endpoints?|routes?)\b/i.test(goal);
}
