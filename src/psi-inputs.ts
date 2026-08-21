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
/**
 * ψ cells are keyed by the SHAPE-SPACE signature, and nothing else is interchangeable with it.
 *
 * MEASURED BY AUDIT, 2026-08-17 — this module's first version passed
 * `getCachedStateSignature()?.signature_hash`, which is a different identifier entirely:
 *
 *              ψ row key (activity-api)              what this module sent
 *   algorithm  sha256                                sha1
 *   width      digest().slice(0,8) -> 16 hex chars   hex.slice(0,8) -> 8 hex chars
 *   over       shapes | provenance | missing         load average, memory, trace counters
 *
 * Not a truncation mismatch — two unrelated identifiers that happen to share the word
 * "signature". No width fix could make them meet.
 *
 * ⚠ THE HARM WAS NOT THE MISS, IT WAS THE SHAPE OF THE MISS. discover-by-shapes gated only on
 * `signature.length > 0`, so the wrong-namespace value PASSED, every cell lookup missed, and
 * every candidate came back `successor_value: {value: 0}` — indistinguishable from "ψ looked
 * and found zero occupancy toward this goal". A lookup that could not be performed was
 * reported as a measurement of zero. That is the n=0-is-not-evidence class, manufactured by
 * my own fix.
 *
 * `/recommend` already had the answer and this reuses it (law 3): it validates the same
 * `^[0-9a-f]{16}$` and, when the caller supplies nothing usable, derives the signature
 * SERVER-SIDE from the shape pool "byte-identical to the write path". So the correct client
 * behaviour when we hold no shape-space signature is to send NOTHING and let the server
 * derive it — never to substitute a plausible-looking value from another namespace.
 */
const SHAPE_SPACE_SIGNATURE = /^[0-9a-f]{16}$/;

export function psiInputs(
  signatureHash: string | null | undefined,
  targetShapes: Iterable<string> | null | undefined,
): { signature?: string; completion_shapes?: string[] } | Record<string, never> {
  if (targetShapes == null) return {};
  const completion_shapes = [...targetShapes].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (completion_shapes.length === 0) return {};

  // THE REFUSAL IS SCOPED TO `signature`, NOT TO THE WHOLE PAYLOAD.
  //
  // The invariant this module exists to protect is: never emit a
  // foreign-namespace identifier as a shape-space signature. Emitting one does
  // not degrade ψ, it FABRICATES a zero. That still holds, and `signature` is
  // still withheld unless it is genuinely shape-space.
  //
  // But withholding `completion_shapes` as well was collateral damage. Every
  // caller in goal-host holds only an 8-hex `signature_hash` from another
  // namespace, so this returned {} at all nine call sites — and
  // `completion_shapes` is a CONJUNCT of the server's ψ guard
  // (activities.ts:6841). Measured: 0 blends in 476 recommends, with SF_BLEND
  // being only one of two independently-sufficient causes.
  //
  // completion_shapes is the goal's target shapes — it needs no signature to be
  // meaningful, and the server derives its own signature on the /recommend
  // path. Sending R without a fabricated s is strictly more information than
  // sending nothing, and it cannot fabricate anything.
  const usableSignature =
    typeof signatureHash === "string" &&
    signatureHash.length > 0 &&
    SHAPE_SPACE_SIGNATURE.test(signatureHash);

  return usableSignature
    ? { signature: signatureHash as string, completion_shapes }
    : { completion_shapes };
}
