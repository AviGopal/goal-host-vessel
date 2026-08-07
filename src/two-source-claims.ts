/**
 * What a produced output actually CLAIMS about a two-source comparison.
 *
 * The reach verifier for these goals computed the authoritative answer correctly and then
 * confirmed agreement with a bag-of-numbers test: winner name appears anywhere in the
 * digest, AND the difference appears anywhere in the digest as a bare integer. Both halves
 * are far too weak, and both failed live on dispatch 188132ba:
 *
 *   authoritative : llm-resolver-vessel=2, boredom-vessel=6, difference 4
 *   produced      : "repos/llm-resolver-vessel/src has 1 fewer TypeScript module ..."
 *                   (and a shellResult reporting a wrong count of 4)
 *   verdict       : REACHED, "the produced output reports the same winner and difference"
 *
 * The digest contained a "4" — from the WRONG COUNT — so `nums.includes(diff)` passed and
 * the output's actual claim of "1 fewer" was never examined. The winner half is weaker
 * still: a comparison names BOTH sources, so "the winner's name is present" is true no
 * matter which one the output declares the winner.
 *
 * These extractors read the claim itself, so the verifier can compare like with like.
 * Both return null when the output makes no such claim, which keeps the existing weaker
 * checks as the fallback rather than turning "unparsed" into "wrong".
 */

/** The difference the output claims, or null if it claims none. */
export function claimedDifference(digest: string): number | null {
  const patterns = [
    /(\d{1,9})\s+(?:fewer|more|less)\b/i,
    /\bdifference(?:\s+of|\s+is)?\s*:?\s*(\d{1,9})\b/i,
    /\b(?:by|larger by|smaller by)\s+(\d{1,9})\b/i,
  ];
  for (const re of patterns) {
    const m = digest.match(re);
    if (m?.[1] !== undefined) return Number(m[1]);
  }
  return null;
}

/**
 * The source the output declares the winner, or null if it declares none.
 *
 * Matched on the phrasing these outputs actually use — "<source> has fewer/more ..." and
 * "the smaller/larger ... is <source>" — and returned verbatim so the caller compares it
 * against its own relA/relB rather than trusting a normalization done here.
 */
export function claimedWinner(digest: string, relA: string, relB: string): string | null {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const rel of [relA, relB]) {
    // "<rel> has (N) fewer/more" / "<rel> has the most"
    if (new RegExp(String.raw`${esc(rel)}\s+(?:has|holds|contains)\b[^.]{0,40}?\b(?:fewer|more|less|most|least|larger|smaller)\b`, 'i').test(digest)) return rel;
    // "the smaller/larger ... is <rel>"
    if (new RegExp(String.raw`\b(?:smaller|larger|fewer|more|winner)\b[^.]{0,60}?\bis\s+${esc(rel)}`, 'i').test(digest)) return rel;
  }
  return null;
}
