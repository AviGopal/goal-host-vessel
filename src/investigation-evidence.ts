/**
 * Build the SOURCE-SEARCH EVIDENCE grep for the investigation floor.
 *
 * WHY THIS EXISTS. The floor greps the goal's symbols across the vessel clones and hands the
 * result to the drafter as the evidence it must ground on. The original command was:
 *
 *   grep -rn -E '(syms)' /workspace/git/vessels/ --include='*.ts' --include='*.js' | head -c 2000
 *
 * with no node_modules exclusion, so the 2000-char budget was consumed by dependency noise
 * before reaching any first-party source. Reproduced in-container for the real symbol set
 * (failed_attempts|parentId|parentSummary): the output was @types/node/inspector.generated.d.ts,
 * @typescript-eslint dist rules and .bun-cache entries. The floor then correctly refused —
 * "the provided SOURCE-SEARCH EVIDENCE does not include any matches for gap-to-feature.ts" —
 * and that honest refusal was graded as a non-reach.
 *
 * Excluding node_modules is necessary but NOT sufficient. With it excluded there are 79 real
 * matches, 24 of them in gap-to-feature.ts — the file the goal explicitly names — but that
 * file first appears at byte 3047, past the 2000-char cut, so ZERO of its matches survive.
 * Both defects have to go, or the drafter still never sees the file it was told to fix.
 *
 * WHY IT MATTERS AT THIS PRICE. Localization is the dominant compose failure: over 40
 * consecutive compose reports, 11 (27.5%) failed to apply at all (anchor not found) and 9
 * (22.5%) applied but were semantically rejected for editing the wrong place — 50% lost
 * before correctness is even in question, while op_count was 1 in 26 of 40, i.e. small
 * patches aimed at the wrong site rather than overreaching ones. Every one of those still
 * pays the full verification cost (bun install + tsc + up to three passes over a 1921-test
 * suite on 14 CPUs), so mis-targeting is what the compute is actually being spent on.
 */

/** Vessel clones live here in the container; a goal names files repo-relative. */
export const VESSELS_ROOT = "/workspace/git/vessels";

/**
 * The file path a goal explicitly names, normalised to its container location.
 *
 * Accepts the `repos/<vessel>/<path>` and `vessels/<vessel>/<path>` forms the goal text uses
 * (same shape as the existing target-inference regexes in index.ts) and maps both onto the
 * clone root. Returns null when the goal names no file — the common case for a symbol-only
 * investigation, which must still get the fleet-wide search.
 */
export function namedFileInGoal(goal: string): string | null {
  const m = goal.match(/\b(?:repos|vessels)\/([\w.-]+)\/([\w./-]+\.\w+)\b/);
  if (!m) return null;
  const vessel = m[1];
  const rest = m[2];
  if (!vessel || !rest) return null;
  // Refuse traversal outright rather than sanitising: a goal is untrusted text, and this
  // string is interpolated into a shell command below.
  if (rest.includes("..") || vessel.includes("..")) return null;
  return `${VESSELS_ROOT}/${vessel}/${rest}`;
}

/** Single-quote a value for safe interpolation into the shell command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Compose the evidence command: the NAMED FILE's matches first, then the fleet-wide search,
 * with dependency directories excluded from both and the whole thing bounded.
 *
 * Ordering is the point. `head -c` keeps a PREFIX, so whatever is printed first is what
 * survives truncation — putting the named file ahead of the fleet-wide sweep is what makes
 * the budget spend on the file the goal actually asked about. The fleet-wide half still runs
 * so a symbol-only goal, or a goal whose named file has no matches, is no worse off than
 * before.
 */
export function buildInvestigationGrepCommand(
  pattern: string,
  goal: string,
  opts: { budgetBytes?: number; namedFileBytes?: number } = {},
): string {
  const budget = opts.budgetBytes ?? 2000;
  // Cap the named-file half so a file with hundreds of matches cannot crowd out every other
  // repository entirely — the drafter still benefits from seeing call sites elsewhere.
  const namedCap = Math.min(opts.namedFileBytes ?? 1200, budget);
  const EXCL = `--include='*.ts' --include='*.js' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.bun-cache`;
  const pat = shq(`(${pattern})`);
  const wide = `grep -rn -E ${pat} ${VESSELS_ROOT}/ ${EXCL} 2>/dev/null`;

  const named = namedFileInGoal(goal);
  if (!named) return `${wide} | head -c ${budget}`;

  // `[ -f ]` guard: a goal may name a path that does not exist in the clone (renamed, or a
  // path the operator mistyped). That must degrade to the fleet-wide search, not error.
  // -H is load-bearing, not decoration: `grep -n` on a SINGLE file omits the filename, so the
  // named-file half would emit bare `725:...` lines. The seed prompt requires the drafter to
  // cite a specific file:line and the citation oracle re-reads the cited path, so unlabelled
  // lines would fail verification even when the evidence was right. Caught by running the
  // generated command in-container rather than by reading it.
  return `{ [ -f ${shq(named)} ] && grep -Hn -E ${pat} ${shq(named)} 2>/dev/null | head -c ${namedCap}; ${wide} | head -c ${budget}; } | head -c ${budget}`;
}
