/**
 * Execution-path classification — HOW a terminalized dispatch was resolved.
 *
 * Extracted into its own module (not inlined in index.ts) so it is unit-testable
 * without booting the vessel's HTTP server, matching goal-target-inference /
 * walk-continuation / satisfier-pick.
 *
 * This label is what an operator is told about a run, what the `execution_path:`
 * trace tag carries, and what any census of "how does this substrate get work
 * done" counts. It is deliberately independent of whether the run SUCCEEDED:
 * classification answers "which mechanism ran", the reach verdict answers
 * "did it work". Conflating them would erase failed direct edits from the
 * census entirely.
 */

/** The five ways goal-host resolves a goal. */
export type WalkTier =
  | "learned_pathway"
  | "satisfier"
  | "universal_tool_fallback"
  | "feature_compose"
  | "fresh_derivation";

export interface TerminalizedSeek {
  selectedTemplateId?: string | null;
  attempts?: number | null;
  reached?: boolean | null;
  executionId?: string | null;
}

/**
 * Order matters, and the first branch is the one that was missing.
 *
 * A landed direct edit returns selectedTemplateId "feature_compose" with
 * attempts===1 and reached===true — which satisfies the "used a known path"
 * predicate exactly. Classifying that as `learned_pathway` credited pathway
 * REUSE for work that reused no pathway at all, and hid every direct edit from
 * consumers counting execution_path.
 */
export function classifyExecutionPath(seek: TerminalizedSeek): WalkTier {
  const tid = typeof seek.selectedTemplateId === "string" ? seek.selectedTemplateId : "";
  const exec = typeof seek.executionId === "string" ? seek.executionId : "";

  // NAMED MECHANISMS FIRST, generic heuristic last. Every one of these returns
  // a concrete selectedTemplateId with attempts===1, and on success reached===
  // true — which is exactly the "reused a known path" heuristic below. Testing
  // that heuristic first swallowed all of them: the floor, satisfier resolves
  // and direct edits were every one reported as `learned_pathway`, so the
  // substrate has been counting its own fallbacks as evidence of learning and
  // the `universal_tool_fallback` branch was unreachable for the only case that
  // returns non-null.
  if (tid === "feature_compose") return "feature_compose";
  if (tid === "universal-tool-fallback" || exec.startsWith("universal-tool-fallback:")) {
    return "universal_tool_fallback";
  }
  if (tid.startsWith("satisfier:")) return "satisfier";

  // Generic: a template that reached on its first attempt is a path this
  // substrate already knew. Only meaningful once the named mechanisms above
  // have been excluded.
  if (tid.length > 0 && seek.attempts === 1 && seek.reached === true) return "learned_pathway";
  return "fresh_derivation";
}
