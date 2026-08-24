/**
 * Is this goal a QUANTITATIVE question about a repository tree — the shape the deterministic
 * oracles exist to answer?
 *
 * The reach gate runs a chain of hand-written verifiers and, when none of them claims the
 * goal, hands it to an LLM judge. For prose and edit goals that is the right fallback. For a
 * countable question about a repos/ path it is not, and the measurement is unambiguous.
 *
 * 80 goals across four classes deliberately chosen to have NO deterministic verifier
 * (subdirectory counts, distinct file extensions, largest-module-by-lines, grep counts):
 *
 *   reached 72/80 (90%)   correct 23/80 (29%)   hollow 49 = 68% of reaches
 *
 *   grep_count    20 reached / 14 correct   (an oracle owns it)
 *   largest_file  18 reached /  7 correct   (partly owned)
 *   subdir_count  14 reached /  2 correct   (nothing owns it)
 *   ext_variety   20 reached /  0 correct   (nothing owns it)
 *
 * Correctness tracks verifier coverage exactly. Where nothing owns the goal the judge passes
 * almost anything, so `reached` stops carrying information — and because a hollow green is
 * indistinguishable from a success, the system has nothing to learn from and no learning
 * curve is possible. Recognising the shape is what lets the gate say "I cannot verify this"
 * instead of guessing.
 *
 * Deliberately NARROW. It requires a repos/ path AND a counting/superlative interrogative,
 * so summaries, explanations, edits and record-this-note goals are untouched — those have no
 * deterministic answer to withhold, and the LLM judge remains their right grader.
 */

/**
 * Does this goal ask for a MEASURABLE quantity at all — in ANY domain?
 *
 * `isQuantitativeRepoQuestion` below requires a `repos/` path because the refusal it gates is
 * calibrated on repo-tree measurements. Independent recompute needs no such calibration: it
 * measures whatever a read-only command can measure, so restricting it to repo trees would
 * reproduce the exact coverage hole that was measured. Registry goals ("how many shapes does
 * the discovery registry advertise?") scored 0/15 — never routed, and with no `repos/` path
 * the refusal never fired either, so nothing observed the failure at all.
 *
 * The prose/edit exclusions stay: those have no measurable answer to recompute.
 */
export function isCountableQuestion(goal: string): boolean {
  const countable = /\b(how many|number of|count(?:\s+of)?|total)\b/i.test(goal);
  const superlative = /\b(largest|biggest|longest|smallest|shortest|most|fewest|highest|lowest)\b/i.test(goal);
  if (!countable && !superlative) return false;
  if (/\b(summar(?:y|ise|ize)|explain|describe|purpose of|overview|gist|walk me through)\b/i.test(goal)) return false;
  if (/\b(edit|insert|append|modify|replace|refactor)\b/i.test(goal)) return false;
  // DELIVERABLE-IS-A-NEW-ARTIFACT. A goal whose deliverable is a new file/module is not a
  // countable question, even when it says "number of" while DESCRIBING that artifact. Its
  // success is the artifact EXISTING (graded by the landing / fs path), not a count — and a
  // count of 0 for "create X" is proof it FAILED, which the recompute path misreads as an
  // agreed answer. Measured live: "Create the new file ...detect-calibration-drift.ts. ...a
  // sufficient number of decisions..." matched `number of`, ran `find|wc -l`=0, and TWO authors
  // agreed on 0 → reached:TRUE, crediting the fallback arm and recording a reusable reached
  // goal-path — a false reach in the β-pump class (wrong-sign credit into the posterior).
  // Match the ASK, not the vocabulary (the same lesson goal-file-resolution learned with
  // "count"): a create/write/author verb BOUND to a file, a "new <artifact>", or a single-file
  // repos path. Over-exclusion here is the SAFE direction — it drops to the LLM judge (status
  // quo), NOT the refusal gate — so a legitimate count-and-record ("write a report on how many
  // resolvers") stays countable while "write a file listing how many resolvers" does not.
  if (/\b(creat|writ|author|scaffold|generat)\w*\b[^.;!?]{0,30}\b(new\s+[a-z]+|file|repos\/[\w./-]+\.\w{1,6})\b/i.test(goal)) return false;
  return true;
}

/** A countable/enumerable question about a repos/ tree. */
export function isQuantitativeRepoQuestion(goal: string): boolean {
  // Must name a repos/ tree (not a single file — a file path is a different family).
  const pathM = goal.match(/repos\/[\w.-]+(?:\/[\w./-]+)?/);
  if (!pathM || /\.\w{1,6}$/.test(pathM[0])) return false;

  if (!isCountableQuestion(goal)) return false;

  // Exclude goals whose deliverable is a mutation: those have their own landing evidence, and
  // withholding a verdict there would suppress real reaches. (Prose, and the edit verbs that
  // cannot also be measurement verbs, are already excluded by isCountableQuestion.)
  if (/\b(edit|add|insert|append|change|modify|replace|fix|remove|delete|rename|refactor)\b/i.test(goal)) return false;

  // Exclude COMPOSITIONAL goals — the ones that also ask for a durable artifact.
  //
  // They have a success signal that does not depend on an oracle owning the question: the
  // artifact either carries the answer or it does not, and the walk's delivery path grades
  // that. Several single-source oracles decline compositional goals BY DESIGN
  // (verifyCountFilesReach bails on isCompositionalGoal), so without this exclusion the
  // refusal inherits every count-and-record goal and calls it unverifiable.
  //
  // Measured immediately after shipping the refusal without it: warm families fell from
  // ~90% reached AND correct to 33%/33%. count_single and lines_single — pure questions —
  // kept working, while count_artifact, compare_more, compare_fewer and combined ALL
  // missed, because every one of them ends "...and record it as a durable note titled X".
  // Those goals had been reaching CORRECTLY; refusing them traded a hollow-green problem
  // for a false-negative one, which is the worse of the two.
  const durableVerb = /\b(record|save|persist|document|capture|writ(?:e|es|ing|ten)?|note down|log|jot|archive)\b/i.test(goal);
  const durableNoun = /\b(notes?|findings?|vault|obsidian|concepts?|report|document|memo|knowledge|journal)\b/i.test(goal);
  if (durableVerb && durableNoun) return false;

  return true;
}
