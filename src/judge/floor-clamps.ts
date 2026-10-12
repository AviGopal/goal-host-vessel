/**
 * THE CLOSED FLOOR CLAMPS. The open rules (src/judge-rules/) cannot override these; they can only tighten
 * relative to them.
 *
 *   F-a  a zero-tool write claim is hollow (zeroToolWriteClaim);
 *   F-b  completion shapes are the PRODUCED shapes only (floorCompletionShapes);
 *   F-d  staged-not-landed is hollow (applied in the reach gate's closed pre-checks);
 *   F-e  the existing secret and safety refusals are untouched.
 */

/**
 * F-a: the text ASSERTS that a write or a tool/resolver call succeeded (or that a record was created).
 * Paired with an execution that ran zero tools and wrote nothing, the assertion is false by construction.
 * The class: an answer that says a write "was likely successful" when no call was ever made.
 */
const WRITE_SUCCESS_CLAIMS: readonly RegExp[] = [
  /\b(?:call|calls|write|writes|request|operation|update|insert|tool\s+call)\b[^.\n]{0,80}?\b(?:was|were|is|has\s+been|have\s+been)\s+(?:likely\s+|probably\s+|most\s+likely\s+)?(?:successful|succeeded|completed|created|written|recorded|filed|persisted|applied|saved)\b/i,
  /\b[A-Za-z]\w*_write\b[^.\n]{0,80}?\b(?:succeeded|successful|success|created|written|recorded|filed|persisted|applied|saved)\b/i,
  /\b(?:i|we)\s+(?:have\s+|successfully\s+|have\s+successfully\s+)?(?:created|filed|wrote|written|recorded|persisted|saved|called|invoked|inserted|updated|registered)\s+(?:a|an|the|it|this|that|new)\b/i,
  /\bsuccessfully\s+(?:created|filed|wrote|written|recorded|persisted|saved|called|invoked|inserted|updated|registered)\b/i,
];

/** A claim that denies the effect inside its own span ("write ... nothing was filed") is not a claim. */
const NEGATION = /\b(?:not|no|nothing|never|cannot|can't|couldn't|didn't|unable|failed)\b|n't\b/i;

export function claimsWriteSucceeded(text: string | undefined | null): boolean {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  return WRITE_SUCCESS_CLAIMS.some((re) => {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of t.matchAll(g)) if (!NEGATION.test(m[0])) return true;
    return false;
  });
}

/** F-a decision: the claim, with no tool run, no write and no output impulse, is hollow. */
export function zeroToolWriteClaim(texts: ReadonlyArray<string | undefined | null>, run: { toolsTotal: number; writes: number; outputImpulses?: number }): boolean {
  if (run.toolsTotal !== 0 || run.writes !== 0 || (run.outputImpulses ?? 0) !== 0) return false;
  return texts.some((t) => claimsWriteSucceeded(t));
}

/**
 * F-b: the floor's completion shapes are the shapes it PRODUCED (its successful write calls), never the
 * shapes it was asked for. A judge-named completion shape survives only if produced. With nothing
 * produced, there are none, and recordGoalPath stores none.
 */
export function floorCompletionShapes(judgeNamed: readonly string[] | undefined, produced: readonly string[]): string[] {
  const prod = [...new Set(produced)];
  const named = (judgeNamed ?? []).filter((s) => prod.includes(s));
  return named.length > 0 ? named : prod;
}
