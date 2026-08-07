/**
 * A VERIFIER DOES NOT HAVE TO BE CODE.
 *
 * The gap this file replaces asked `feature_compose` to author a TypeScript verifier per goal
 * family, and the composer REFUSED it before authoring anything:
 *
 *     [gap-to-feature] pick {"gap_id":"missing-verifier-distinct-file-extensions",
 *                           "target":"(no-target)"}
 *     [fc-grounding] REFUSED ungrounded decompose; targetFiles=[] verify_vessels=[]
 *
 * Grounding was the immediate cause, but routing verifier growth through code authoring is the
 * deeper mistake. Every new family would need a drafted function, a typecheck, a mitosis
 * cutover and a restart — and it lands in a composable-gap queue drained by one watchdog fire
 * per 20-minute stall against 465 open gaps. Capability that expensive does not grow.
 *
 * A RECIPE is the same verifier as data. When triangulation establishes truth — two
 * independently authored commands agreeing on a measurement — the command that measured it is
 * already a verifier for the whole family; it just has one vessel's path baked into it.
 * Generalise that path to a placeholder and the recipe answers every member of the family, for
 * free, with no LLM and no new code.
 *
 * This is law 1 as it was meant to work: the behaviour is steered by a shaped value read at use
 * time, not by a constant compiled into the process. It is also law 3 — the recipe REUSES the
 * derivation the system already paid for instead of minting a new producer.
 *
 * WHAT IT MUST NOT DO IS REPLACE VERIFICATION. A recipe is a MINT, and every mint arrives
 * with a blank prior: if it were allowed to answer on its own it would become an ungraded arm
 * that bypasses the credit path, splitting selection traffic while earning nothing — the exact
 * cost law 3 names, and worse here because this arm decides what counts as TRUE.
 *
 * So a recipe is never an oracle. It is used as ONE OF THE TWO DERIVATIONS, checked on every
 * single use against a fresh independently-authored one. That has three properties worth the
 * complexity:
 *
 *   - The verifier is itself verified, continuously, by the mechanism it participates in.
 *     It cannot drift into being trusted; it re-earns agreement every time it is used.
 *   - No credit fragments. Nothing new is minted into the selection pool — the recipe seeds
 *     one side of machinery that already exists and is already graded.
 *   - Agreement gets CHEAPER without getting looser. Today both derivations are authored by a
 *     model and frequently disagree or abstain, which is what pins reach on unowned families.
 *     A proven recipe on one side raises agreement rate while the evidence bar is unchanged:
 *     two independent derivations still have to land on the same number.
 *
 * A recipe that stops agreeing is demoted, because a verifier whose disagreements are excused
 * is the self-confirming oracle this session found in three separate places.
 */

/** The repository tree a countable goal names. One tree; a multi-tree goal is a different family. */
export function goalTreePath(goal: string): string | null {
  const all = [...new Set((goal.match(/repos\/[\w.-]+(?:\/[\w./-]+)?/g) ?? []).map((m) => m.replace(/[.,;:]+$/, "")))];
  if (all.length !== 1) return null;               // 0 = not a tree goal; >1 = the chain form, which one command cannot answer
  const p = all[0]!;
  return /\.\w{1,6}$/.test(p) ? null : p;          // a FILE path is not a tree
}

/**
 * Turn a command that measured ONE vessel into a recipe for the family.
 *
 * The generalisation is deliberately literal: the goal's tree path must appear in the command
 * verbatim, exactly once. That is a causal proof the path is what flowed into the measurement,
 * the same gate `tryLexicalRebind` relies on — not a similarity guess. Anything else abstains,
 * because a recipe that substitutes the wrong span produces confidently wrong ground truth on
 * every future member of the family, which is the most expensive error available here.
 */
export function generaliseCommand(command: string, treePath: string): string | null {
  if (!command || !treePath) return null;
  const first = command.indexOf(treePath);
  if (first < 0) return null;                                       // path never reached the command
  if (command.indexOf(treePath, first + 1) >= 0) return null;       // ambiguous: refuse
  const template = command.slice(0, first) + "{{tree}}" + command.slice(first + treePath.length);

  // NO VESSEL-SPECIFIC LITERAL MAY SURVIVE. Observed live on the first mint:
  //
  //   MINTED recipe for family "largest-module-by-lines" from a triangulated truth (0):
  //     `find /workspace/git/vessels/cpg-inference-ts/{{tree}} -name "*.ts" ...`
  //
  // The command addressed the tree by its DEPLOYED path, so only the trailing segment matched
  // the goal's `repos/<vessel>/...` span. The slot went in, the vessel name stayed, and the
  // result would have measured cpg-inference-ts for every member of the family. (The audit
  // caught it on first use — CONTRADICTED 0 vs 622, retired — which is the design working, but
  // a mint that can only be corrected after being wrong is a mint worth refusing.)
  //
  // A family recipe that still names one vessel is not a family recipe.
  const vessel = treePath.split("/")[1];
  if (vessel && template.includes(vessel)) return null;
  return template;
}

/** Bind a recipe to a concrete goal. Mirrors generaliseCommand exactly, so a round-trip is identity. */
export function instantiateRecipe(template: string, treePath: string): string | null {
  if (!template.includes("{{tree}}")) return null;
  if (!/^repos\/[\w.-]+(?:\/[\w./-]+)?$/.test(treePath)) return null;  // never interpolate an unvetted span
  return template.split("{{tree}}").join(treePath);
}

export type VerifierRecipe = {
  family: string;
  template: string;
  /** The goal that earned it, kept so a wrong recipe can be traced to its origin. */
  originGoal: string;
  /** The triangulated value that goal measured — evidence the template actually works. */
  originValue: number;
  /** Times a fresh derivation landed on the same value as this recipe. */
  agreed: number;
  /** Times it did not. A recipe is evidence, not authority, and this is the counter-evidence. */
  disagreed: number;
};

/**
 * Should this recipe still be used as a derivation?
 *
 * Retirement is deliberately unforgiving. A recipe that is wrong produces wrong ground truth on
 * every future member of its family, and wrong ground truth returns `disagree` verdicts that
 * carry β — the failure that took reach 25/48 -> 18/48 and had to be reverted. Two
 * disagreements with no majority of agreements is enough to stop using it; the cost of
 * retiring a good recipe is one extra model call, the cost of keeping a bad one is a poisoned
 * posterior on every goal in the family.
 */
export function recipeIsLive(r: VerifierRecipe): boolean {
  if (r.disagreed === 0) return true;
  return r.agreed > r.disagreed * 2;
}

/**
 * Is this recipe usable for this goal? Same family, and the goal names exactly one tree.
 *
 * Family membership is decided by the caller (verifierFamilyOf); this only guards the binding.
 */
export function recipeAppliesTo(recipe: VerifierRecipe, family: string, treePath: string | null): boolean {
  return recipe.family === family && treePath !== null && recipe.template.includes("{{tree}}");
}
