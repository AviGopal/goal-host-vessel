/**
 * THE β DECISION ON A HOLLOW (closed): whether a not-reached verdict charges the last pick's template.
 *
 * It stays closed because it moves posteriors: an open β rule could withhold β everywhere and so loosen
 * learning. The verdict corpus pins it through this pure entry (case kind `credit`).
 *
 * The rule (unchanged): β is held to the same evidence standard as α, or the arm can only lose.
 *   - the last pick's own answer DECLINED (design ruling: reached / failed / declined): β withheld (a correct
 *     refusal is not a hollow; it is ungraded, and its trace carries declined:<class>);
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

export type CreditWithheld = "declined" | "no-oracle-for-goal-class" | "alpha-unreachable-non-deterministic-no-edge" | "not-producer-of-judged-artifact";

export interface CreditOnHollowDecision {
  alpha_reachable: boolean;
  /** β is applied to the last pick's template. */
  charge: boolean;
  withheld: CreditWithheld | null;
  retire_candidate: boolean;
}

export function creditOnHollow(i: CreditOnHollowInput): CreditOnHollowDecision {
  const declined = typeof i.declined === "string" && i.declined.length > 0;
  const noOracle = i.verdict.no_oracle === true;
  const alphaReachable = i.verdict.deterministic === true || i.consumed_in_chain > 0;
  const withheldForSymmetry = !noOracle && !alphaReachable;
  const withheldForCulpability = !noOracle && !withheldForSymmetry && !i.last_pick_produced_judged_artifact;
  const withheld: CreditWithheld | null = declined ? "declined" : noOracle ? "no-oracle-for-goal-class"
    : withheldForSymmetry ? "alpha-unreachable-non-deterministic-no-edge"
    : withheldForCulpability ? "not-producer-of-judged-artifact" : null;
  return { alpha_reachable: alphaReachable, charge: withheld === null, withheld, retire_candidate: false };
}

/** Why a declined answer declined: its class (the declined:<class> trace tag) and the decliner's own reason text. */
export interface SatisfierDecline { class: "needs_information" | "decomposition_refused"; reason: string }

/**
 * Whether a satisfier's answer is a DECLINE, read from the answer itself, never from the goal's wording. Inclusion
 * only, by the markers the decliner writes (development-vessel gapDecomposition, through decomposeGap and
 * armDecomposition): an answer that wrote nothing and says `needs_information: …`, `no valid step: …`,
 * `cannot_falsify: …` or the depth refusal. A decomposer that FAILED (the LLM call, an unparseable answer) is not a
 * decline and stays charged, as is any answer that wrote something.
 */
export function satisfierDeclineClass(answer: unknown): SatisfierDecline | null {
  const a = answer && typeof answer === "object" ? answer as Record<string, unknown> : null;
  const b = (a && a.body && typeof a.body === "object" ? a.body : a) as Record<string, unknown> | null;
  if (!b || b.ok !== false || b.stage !== "decompose" || typeof b.reason !== "string") return null;
  if (Array.isArray(b.children) && b.children.length > 0) return null;
  const reason = b.reason.trim();
  if (/^needs_information\b/.test(reason)) return { class: "needs_information", reason: reason.slice(0, 600) };
  if (/^(no valid step:|cannot_falsify:|a decomposed step is not decomposed again$)/.test(reason)) return { class: "decomposition_refused", reason: reason.slice(0, 600) };
  return null;
}
