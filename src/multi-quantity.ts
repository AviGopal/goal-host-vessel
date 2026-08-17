/**
 * Does this goal ask for MORE THAN ONE quantity? — computed, not asserted.
 *
 * MEASURED 2026-08-17. "Count the .ts files directly inside /vessels/goal-host-vessel/src,
 * then count the .ts files directly inside /vessels/ribosome-vessel/src, then report the SUM"
 * (truth 57 + 2 = 59). The walk ran
 *
 *     find /vessels/goal-host-vessel/src -maxdepth 1 -type f -name '*.ts' | wc -l
 *
 * — ONE operand — was correctly graded hollow, and the retry then SUPPRESSED the shell
 * satisfier and widened targets, walking away from the only producer that could answer and
 * into webSearchResult, which died on credits. The goal never reached.
 *
 * The producer was right and its ARGUMENT was incomplete. Nothing in the loop said so at the
 * point where the command is written.
 *
 * WHY THIS IS A FACT AND NOT A RULE. The distinction is load-bearing and was learned the
 * expensive way: on this substrate, instructions added to prompts have a 0/7 record at
 * changing behaviour, while supplying the missing FACT at the point of use has 3/3. So this
 * does not tell the executor to "be thorough" — it computes something true about the goal
 * (it names N distinct paths / counted entities) and states it. A supplied fact cannot
 * compose wrongly; an instruction can be read past.
 *
 * Returns null when the goal asks for one quantity, so single-operand goals are unaffected.
 */

/** Distinct filesystem paths named by the goal, in order of appearance. */
export function pathsNamedIn(goal: string): string[] {
  const out: string[] = [];
  const re = /(?:\/[\w.-]+){2,}|\b(?:repos|vessels|docs|scripts|openspec|validation|packages)\/[\w./-]+/g;
  for (const m of goal.match(re) ?? []) {
    const p = m.replace(/[.,;:)]+$/, "");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Words that combine two quantities into one answer. */
const COMBINATOR = /\b(?:sum|total of|combined|together|plus|add(?:ed)?|difference|minus|subtract|ratio|divide[ds]?|quotient|average|mean|per)\b/i;

/**
 * A short factual note for the executor prompt, or null when the goal is single-quantity.
 *
 * Deliberately states WHAT IS TRUE (the goal names these N paths; it asks for them combined)
 * and the one consequence that follows mechanically (an answer carrying one of them is not
 * the requested value). It does not prescribe a command — choosing the command is the
 * executor's job, and prescribing it here would be a second fast path.
 */
export function multiQuantityNote(goal: string): string | null {
  const paths = pathsNamedIn(goal);
  const combines = COMBINATOR.test(goal);

  if (paths.length >= 2) {
    return (
      `STRUCTURAL FACT about this goal: it names ${paths.length} distinct paths — ${paths.join(", ")}. ` +
      `A result derived from only one of them is a partial answer to a different question, not this one. ` +
      (combines
        ? `The goal asks for them COMBINED, so the final value must be the combination, not either input.`
        : `Each named path must be covered by the answer.`)
    );
  }

  // Two counted entities in one clause ("shapes ... vessels") with a combinator: same shape of
  // failure without any path being named.
  if (combines) {
    const counted = [...goal.toLowerCase().matchAll(/\b(?:how many|number of|count(?:s)? of|total)\s+((?:\w+\s+){0,2}\w+)/gi)]
      .map((m) => m[1]!.trim())
      .filter(Boolean);
    if (counted.length >= 2) {
      return (
        `STRUCTURAL FACT about this goal: it asks for ${counted.length} separate quantities and a combination of them. ` +
        `Producing one of the quantities is not the requested value — the answer is the combined result.`
      );
    }
  }
  return null;
}
