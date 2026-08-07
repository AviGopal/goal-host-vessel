/**
 * THE REFUSAL IS A DETECTED CAPABILITY GAP, AND IT WAS FILING NOTHING.
 *
 * When the reach gate reaches the end of the deterministic chain on a countable question and
 * no verifier claims it, it returns `no-oracle-for-goal-class` and withholds β — correctly,
 * because the missing verifier is ours, not the arm's fault. But that verdict then goes
 * nowhere. Measured across seven repeated-exposure runs at per-class granularity: **every goal
 * class is either saturated from round 0 or zero in all four rounds. Not one class starts low
 * and rises.** Reach is a deterministic function of capability, and the refusal — the system's
 * own testimony about which capability is missing — was not being turned into work.
 *
 * Law 6: every observed bug class gets asked what activity would detect and repair it without
 * an operator. This one detects itself already. What was missing is the second half: filing it
 * so `gap_to_feature -> feature_compose -> mitosis` can AUTHOR the verifier, after which reach
 * on that class rises without anyone hand-writing an oracle. That is the only mechanism by
 * which "more reaches over time" can be true of a system whose per-class reach is otherwise
 * deterministic — capability has to grow, and this is the loop that grows it.
 *
 * Three attempts to grow capability from EXECUTION experience were measured and eliminated
 * first (loosening ground truth poisoned selection at 25/48 -> 18/48; both donation variants
 * fired ~0 times because truth only exists where the walk already succeeded). Capability growth
 * has to come from authoring, not from replaying, and authoring is what the gap store drives.
 */

/**
 * The FAMILY a countable goal belongs to — vessel names and paths stripped out.
 *
 * The gap id must be per-family, never per-goal. "How many subdirectories under
 * repos/activity-api/src" and the same question about repos/concept-db/src need ONE verifier
 * between them, and filing one gap per goal would flood the store with rows describing a
 * single missing capability — the failure mode `reach-gap-*` already demonstrated at 105 rows
 * and 3,090 executions at 4% reach.
 */
export function verifierFamilyOf(goal: string): string | null {
  const g = goal.toLowerCase();
  // Ordered most-specific first: "distinct file extensions" also contains "file".
  const families: Array<[RegExp, string]> = [
    [/\bdistinct\b[^.?]*\bextensions?\b|\bextensions?\b[^.?]*\bdistinct\b/, "distinct-file-extensions"],
    [/\bsub-?directories\b|\bsub-?dirs?\b|\bfolders?\b/, "subdirectory-count"],
    [/\b(largest|biggest|longest)\b[^.?]*\b(module|file)\b|\b(module|file)\b[^.?]*\bmost lines\b/, "largest-module-by-lines"],
    [/\bfunctions?\b/, "function-count"],
    [/\bexports?\b/, "export-count"],
    [/\bimports?\b/, "import-count"],
    [/\bendpoints?\b|\broutes?\b/, "endpoint-count"],
    [/\bdependencies\b|\bpackages?\b/, "dependency-count"],
  ];
  for (const [re, name] of families) if (re.test(g)) return name;
  return null;
}

/**
 * Build the gap. Scope-narrowed the same way `fileCapabilityGap` is: name exactly one missing
 * verifier, say what it must compute, and forbid widening — an authoring path that is allowed
 * to expand scope is how a self-modifying system drifts.
 */
export function missingVerifierGap(family: string, exampleGoal: string): {
  id: string; category: string; source: string; status: string; summary: string;
} {
  return {
    id: `missing-verifier-${family}`,
    category: "missing_capability",
    source: "substrate_detected",
    status: "open",
    summary:
      `Missing deterministic reach verifier for the goal family "${family}". The reach gate ` +
      `reaches the end of its verifier chain on these goals, finds nothing that claims them, ` +
      `and returns not-reached with beta WITHHELD — an honest verdict that can never change, ` +
      `so reach on this family is pinned regardless of how many times it is attempted. ` +
      `Example goal: "${exampleGoal.slice(0, 200)}". ` +
      `AUTHOR one verifier in repos/goal-host-vessel/src that computes the answer for THIS ` +
      `family from the authoritative git clone (the readdir/in-process route the sibling ` +
      `verifiers use — NOT by re-running the walk's own command, which would agree with it by ` +
      `construction), and returns a three-verdict result: reached when the produced output ` +
      `states the computed value, not-reached when it states a different one, null when it ` +
      `states none. Follow the existing verifyCountFilesReach / verifyAggregateReach shape. ` +
      `Do NOT expand scope: one family, one verifier, and it must DECLINE any goal whose ` +
      `scope its parse does not represent — that exact defect has been found three times ` +
      `(extension goals claimed by the file-count oracle, by the command builder, and ` +
      `two-tree chain goals claimed by the aggregate oracle).`,
  };
}
