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
export type RegistryField = "totalVessels" | "totalShapes" | "healthyCount";

export function registryFieldFor(goal: string): RegistryField | null {
  const g = goal.toLowerCase();

  // ABSTAIN WHEN THE GOAL IS COMPOSITIONAL — measured false reach, 2026-08-17.
  //
  // "Divide the registry total shape count by the registry total vessel count and report the
  // quotient" (true answer ~28.5) fired this fast path, which answered `totalShapes` = 368.
  // The deterministic oracle then CONFIRMED it — correctly, for its own question — and the
  // arm took alpha +2. The substrate answered a simpler question than the one asked and was
  // rewarded for it.
  //
  // A single-field lookup cannot answer a goal that combines two counts, so returning a field
  // here is not a partial answer, it is a WRONG one that the verifier is guaranteed to bless:
  // both sides derive from this same function, so a mistake here is confirmed rather than
  // caught. That shared-source property is what makes agreement cheap and this abstention
  // load-bearing.
  //
  // This is the invariant recorded on 2026-08-16 — "if both count, abstain" — which had been
  // written down and never implemented. Abstaining routes the goal back to the walk, which is
  // where composition happens; the cost is an LLM judgement, and the alternative is teaching
  // the learner that a dropped operand is a success.
  // Scan a short window after the counting trigger rather than the single next word: "how
  // many HEALTHY vessels" puts an adjective there, and taking it literally made this abstain
  // on a goal it should answer. Surfaced by a test written for the abstention above, which
  // asserted healthyCount and got null — the limitation predates that change.
  const counted = [...g.matchAll(/\b(?:how many|number of|total)\s+((?:\w+\s+){0,2}\w+)/gi)]
    .map((m) => m[1]!.toLowerCase().split(/\s+/).find((w) => /^(?:vessels?|shapes?)$/.test(w)))
    .filter((w): w is string => Boolean(w));
  const distinctEntities = new Set(counted.map((w) => (w.startsWith("vessel") ? "vessel" : "shape")));
  if (distinctEntities.size > 1) return null;

  // Arithmetic over the count is the same failure wearing different words — "shapes per
  // vessel" names one counted entity but still needs two numbers. Caught separately so a
  // rephrasing cannot slip past the entity check above.
  if (/\b(?:divide[ds]?|division|quotient|ratio|average|mean|per\s+vessel|per\s+shape|fraction|percentage|percent|difference|subtract|multiplied|times)\b/.test(g)) {
    return null;
  }

  const first = counted[0] ?? "";
  if (/^vessels?$/.test(first)) return /\bhealthy\b/.test(g) ? "healthyCount" : "totalVessels";
  if (/^shapes?$/.test(first)) return "totalShapes";
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

/**
 * THE COMPOSITIONAL CASE: a QUOTIENT of two registry counts.
 *
 * Abstaining (above) stopped the substrate answering "shapes ÷ vessels" with `totalShapes`
 * and being graded reached for it. But abstention alone leaves the goal with no producer at
 * all: the measured re-run walked, found nothing local, selected webSearchResult, and died on
 * credits — a goal answerable by ONE command against an endpoint it had already queried
 * seconds earlier.
 *
 * `registry/stats` returns every field in a single response, so the quotient needs no second
 * fetch and no cross-source join — the composition is arithmetic over one body. This returns
 * the fields for it; the caller emits `jq '.a / .b'` and the oracle recomputes the same
 * quotient from its own independent fetch.
 *
 * Numerator is the entity mentioned FIRST. That reads correctly for every phrasing measured
 * — "shapes per vessel", "divide the total shape count by the total vessel count", "ratio of
 * shapes to vessels" — because English puts the dividend first in all three.
 *
 * DIVISION ONLY, deliberately. Differences and percentages are recognised by the abstention
 * above and stay abstained: each needs its own verifier, and a producer whose oracle cannot
 * check it is how a false reach gets manufactured. Widen only with the matching oracle.
 */
export function registryRatioFor(goal: string): { numerator: RegistryField; denominator: RegistryField } | null {
  const g = goal.toLowerCase();
  if (!/\b(registr(?:y|ies|ered|ration)|discovery)\b/.test(g)) return null;
  // Only the division family; "difference"/"percentage" deliberately absent.
  if (!/\b(?:divide[ds]?|division|quotient|ratio|average|mean|per)\b/.test(g)) return null;

  const shapeAt = g.search(/\bshapes?\b/);
  const vesselAt = g.search(/\bvessels?\b/);
  if (shapeAt < 0 || vesselAt < 0) return null;      // needs BOTH entities to be a quotient

  const healthy = /\bhealthy\b/.test(g);
  const shapeField: RegistryField = "totalShapes";
  const vesselField: RegistryField = healthy ? "healthyCount" : "totalVessels";
  return shapeAt < vesselAt
    ? { numerator: shapeField, denominator: vesselField }
    : { numerator: vesselField, denominator: shapeField };
}

/** The one command that answers a registry quotient, from the single stats body. */
export function registryRatioCommandFor(goal: string, endpoint: string): string | null {
  const r = registryRatioFor(goal);
  return r ? `curl -s ${endpoint}/registry/stats | jq '.${r.numerator} / .${r.denominator}'` : null;
}
