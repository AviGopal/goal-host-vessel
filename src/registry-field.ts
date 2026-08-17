/**
 * Registry count: which field the goal asked for, and the command that answers it.
 *
 * Extracted into its own module (not inlined in index.ts) so it is unit-testable without
 * booting the vessel's HTTP server — the same reason walk-budget and body-honesty-policy
 * are separate. The first attempt to test it in place failed on createLLMPort at import.
 */

/**
 * THE COUNTED ENTITY DECIDES THE FIELD — one function, used by BOTH the oracle that
 * verifies a registry count and the synthesiser that produces one, so they cannot disagree.
 *
 * Two measured failures made this shared rather than duplicated. The oracle originally
 * tested /\bvessels?\b/ against the WHOLE goal and ran it first, so "a health report for
 * the vessel X ... how many SHAPES" graded against totalVessels and failed a correct
 * answer — the sixth recurrence of that class, each earlier fix having guarded the
 * symptom. Then, with the oracle fixed, the WALK kept answering the same goal with the
 * wrong quantity: 12 (the vessel's own advertised_shapes length), then 13 (the registry's
 * vessel count), against a true totalShapes of 368. Two prompt interventions left that
 * rate unchanged, which is what moved this from guidance to structure.
 *
 * null means ABSTAIN: no counting clause, or one naming an entity the registry does not
 * report. Abstaining costs an LLM judgement; guessing poisons the posterior of an arm that
 * was right.
 */
export function registryFieldFor(goal: string): "totalVessels" | "totalShapes" | "healthyCount" | null {
  const g = goal.toLowerCase();
  const counted = /\b(?:how many|number of|total)\s+(\w+)/i.exec(g)?.[1]?.toLowerCase() ?? "";
  if (/^vessels?$/.test(counted)) return /\bhealthy\b/.test(g) ? "healthyCount" : "totalVessels";
  if (/^shapes?$/.test(counted)) return "totalShapes";
  return null;
}

/**
 * The command that answers the goal from the source AND FIELD the goal named.
 *
 * Binding the field is the whole point. The walk already reached the right source — it
 * queried registry/stats — and read the wrong column out of the response, so a binding
 * that names only the source cannot prevent the error. This names both, and derives the
 * field from the SAME registryFieldFor the verifier uses.
 */
export function registryCountCommandFor(goal: string, endpoint: string): string | null {
  if (!/\bregistry\b/i.test(goal)) return null;
  const field = registryFieldFor(goal);
  return field ? `curl -s ${endpoint}/registry/stats | jq .${field}` : null;
}
