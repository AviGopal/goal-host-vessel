/**
 * INDEPENDENT LANDING EVIDENCE FOR A FAVORABLE COMPOSE (D2 step 1; design approved by qa 2026-10-16 ~12:00Z).
 *
 * verifyGoalReached's favorableCompose branch returned reached:true from the DIGEST TEXT alone: a featureComposeReport
 * line saying FAVORABLE plus `push_status: pushed` or any `new_git_sha` (substrate-authored 0b64e0b, 07-04). Its reason
 * said "landed on origin/dev", but nothing looked at origin/dev, and it returned before landedEditOf and the reach gate.
 * The producer's own report graded the producer.
 *
 * This reads the evidence from OUTSIDE the producer: each (vessel, new_git_sha) the report names must be an ancestor of
 * origin/dev in that vessel's clone (/workspace/git/vessels/<vessel>, the clone pull-sync fast-forwards; a quiet fetch
 * first, as landedCommitForGoal does). Confirmed only if at least one named sha is on origin/dev. Every doubt (no pair,
 * a bad name, a git error, not an ancestor) is NOT confirmed: the caller then falls through to its other checks,
 * never to a reach.
 */
export interface ComposeLanding { vessel: string; sha: string }
export type GitRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

const VESSEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The (vessel, new_git_sha) pairs a compose report names in its cutovers, in order. */
export function composeLandingClaims(digest: string): ComposeLanding[] {
  const out: ComposeLanding[] = [];
  const re = /"vessel"\s*:\s*"([^"]{1,64})"[\s\S]{0,600}?"new_git_sha"\s*:\s*"([0-9a-f]{7,40})"/g;
  for (const m of digest.matchAll(re)) {
    const vessel = m[1]!;
    const sha = m[2]!;
    if (!VESSEL_RE.test(vessel) || vessel.includes("..")) continue;
    if (!out.some((x) => x.vessel === vessel && x.sha === sha)) out.push({ vessel, sha });
  }
  return out;
}

const defaultGit: GitRunner = async (args) => {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore", timeout: 20_000 });
  const stdout = await new Response(p.stdout).text();
  return { code: await p.exited, stdout };
};

/** The first claimed landing that origin/dev actually contains, or null. */
export async function confirmComposeLanding(digest: string, git: GitRunner = defaultGit): Promise<ComposeLanding | null> {
  const claims = composeLandingClaims(digest);
  const fetched = new Set<string>();
  for (const c of claims) {
    const dir = `/workspace/git/vessels/${c.vessel}`;
    try {
      if (!fetched.has(c.vessel)) { fetched.add(c.vessel); await git(["-C", dir, "fetch", "--quiet", "origin", "dev"]); }
      const r = await git(["-C", dir, "merge-base", "--is-ancestor", c.sha, "origin/dev"]);
      if (r.code === 0) return c;
    } catch { /* not confirmed */ }
  }
  return null;
}
