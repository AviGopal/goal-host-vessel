/**
 * The two inputs activity-api needs before it will compute a successor-feature value.
 *
 * WHY THIS EXISTS (measured 2026-08-17, from the architecture docs — nothing was failing).
 *
 * `SUBSTRATE_AS_MDP.md` §12.1 names ψ as the ONLY genuine multi-step structure in this
 * system: the load-bearing mechanism is a contextual Beta-Bernoulli bandit whose actions
 * score immediate reward with no bootstrapped next-state value, and "one partial exception
 * exists: the successor-feature cell ψ (§2.2) does model the discounted multi-step
 * shape-occupancy of the continuation". §2.2 gives the readout as Q_sf = ⟨ψ(s,a), R⟩ with s
 * the state `signature` and R the goal direction built from `completion_shapes`.
 *
 * The store computes it behind exactly this guard (discover-by-shapes):
 *
 *     isCandidatesMode && successorFeaturesEnabled()
 *       && typeof signature === 'string' && signature.length > 0
 *       && completion_shapes.length > 0
 *
 * The walk satisfied neither half, for two independent reasons:
 *   - it sent the state under `state_signature`, which that service destructures as a
 *     SEPARATE field (the cts lookup key). To a reader the payload looks like it carries
 *     a signature; to the ψ guard it carries none.
 *   - it never sent `completion_shapes` at all, though it holds the goal's target shape
 *     set — which IS R — a few lines above every call site.
 * On the recommend fallback the same direction went out as `expected_output_shapes`, also
 * a separately-destructured field on that route. No aliasing exists on either path.
 *
 * EACH DEFECT ALONE ZEROES ψ, so fixing any one of them changes nothing measurable. That is
 * the same amputated-in-series shape as the argument chain (five layers) and the
 * composition-score blend (two) — and it is why the fix is a SINGLE helper used at every
 * site rather than four edits: the recurring failure in this codebase is not getting a
 * payload wrong, it is getting it right in one of N places.
 *
 * WHAT THIS DOES NOT DO. It does not turn ψ on. §2.2 is explicit that the recommend-side
 * blend "is a gated selection-layer refinement whose default preserves the pure Thompson
 * order byte-for-byte — the blend must be deliberately enabled to alter selection". Making
 * ψ computable is a prerequisite for measuring it; enabling the blend is a separate,
 * deliberate act that should be made against observed values, not ahead of them. Wiring an
 * input and turning on a behaviour are different changes and must not be credited as one.
 */

/**
 * Build the `{ signature, completion_shapes }` half of a discover-by-shapes request.
 *
 * ALL-OR-NOTHING BY DESIGN. The store's guard requires both, so emitting one without the
 * other produces a payload that reads as "ψ was requested" while computing nothing — the
 * silent-partial-payload failure this module exists to end. When either input is missing
 * the result is empty and the request is honestly ψ-less.
 */
export function psiInputs(
  signatureHash: string | null | undefined,
  targetShapes: Iterable<string> | null | undefined,
): { signature: string; completion_shapes: string[] } | Record<string, never> {
  if (typeof signatureHash !== "string" || signatureHash.length === 0) return {};
  if (targetShapes == null) return {};
  const completion_shapes = [...targetShapes].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (completion_shapes.length === 0) return {};
  return { signature: signatureHash, completion_shapes };
}
