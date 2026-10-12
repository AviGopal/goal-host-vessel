/**
 * THE β DECISION ON A HOLLOW (closed): whether a not-reached verdict charges the last pick's template.
 *
 * It stays closed because it moves posteriors: an open β rule could withhold β everywhere and so loosen
 * learning. The verdict corpus pins it through this pure entry (case kind `credit`).
 *
 * The rule (unchanged): β is held to the same evidence standard as α, or the arm can only lose.
 *   - no oracle owns the goal class: β withheld (the gap is the missing verifier, not the pathway);
 *   - α was structurally unreachable for this verdict (non-deterministic, and nothing consumed in-chain,
 *     which every satisfier pick is): β withheld (the gap is the missing producer -> consumer edge);
 *   - the last pick did not produce the judged artifact: β withheld (the producer is charged through the
 *     failed composite's consumed provenance);
 *   - otherwise β is charged.
 *
 * `history` (the template's recent attempts) is carried in the record and does not yet change the
 * decision: a template whose every attempt fails the same way is withheld exactly as above.
 */
import type { CreditOnHollowInput } from "./records";

export type CreditWithheld = "no-oracle-for-goal-class" | "alpha-unreachable-non-deterministic-no-edge" | "not-producer-of-judged-artifact";

export interface CreditOnHollowDecision {
  alpha_reachable: boolean;
  /** β is applied to the last pick's template. */
  charge: boolean;
  withheld: CreditWithheld | null;
  retire_candidate: boolean;
}

export function creditOnHollow(i: CreditOnHollowInput): CreditOnHollowDecision {
  const noOracle = i.verdict.no_oracle === true;
  const alphaReachable = i.verdict.deterministic === true || i.consumed_in_chain > 0;
  const withheldForSymmetry = !noOracle && !alphaReachable;
  const withheldForCulpability = !noOracle && !withheldForSymmetry && !i.last_pick_produced_judged_artifact;
  const withheld: CreditWithheld | null = noOracle ? "no-oracle-for-goal-class"
    : withheldForSymmetry ? "alpha-unreachable-non-deterministic-no-edge"
    : withheldForCulpability ? "not-producer-of-judged-artifact" : null;
  return { alpha_reachable: alphaReachable, charge: withheld === null, withheld, retire_candidate: false };
}
