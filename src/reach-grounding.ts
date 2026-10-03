/**
 * THE LLM REACH JUDGE'S DECISION, OUT OF index.ts SO IT CAN BE TESTED.
 *
 * Moved VERBATIM from `llmJudgeReach` (index.ts): the judge prompt, and the parse + sanitise of the
 * judge's reply (negation phrases, `deterministic` forced false, `deterministic:` reason prefix
 * rewritten). index.ts keeps only the routing (routedComplete, reach_verification) and passes it in
 * as `complete`, so a test can stand in for the model. Importing index.ts boots the host, so the
 * judge was unreachable from a unit test until now.
 *
 * `now` is accepted on the input for the run clock; nothing reads it at this commit.
 */

export interface ReachJudgeInput {
  goal: string;
  producedShapes: string[];
  taskSummary: string;
  contentDigest?: string;
  commandEvidence?: string;
  /** The run clock (injected in tests; the host clock otherwise). */
  now?: Date;
}

/** Structurally a GoalReachVerdict (index.ts). */
export interface ReachJudgeVerdict {
  reached: boolean;
  reason: string;
  completion_shapes: string[];
  missing?: string[];
  deterministic: boolean;
}

/** The model call: the prompt in, the reply text out; null when the call failed. */
export type ReachJudgeComplete = (prompt: string) => Promise<unknown | null>;

export function buildReachJudgePrompt(goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string, commandEvidence?: string): string {
  const cmdSection = commandEvidence
    ? `\n\nCOMMANDS THAT PRODUCED THE OUTPUT (judge command<->intent alignment):\n${commandEvidence}\nWhen an answer was produced by RUNNING a command shown above, VERIFY the command actually accomplishes what the goal asks, and be SKEPTICAL of a DEGENERATE result (0 / empty / error) from it: for a "how many / count / list / are there" goal on a system that plainly contains such items, a 0/empty result usually means the command was wrong or ran in the wrong context — grade that reach HOLLOW (reached:false) unless the command clearly and correctly targets what the goal asks. ALSO grade HOLLOW when the command merely ECHOES or PRINTS a literal answer (e.g. echo or printf of a constant) instead of MEASURING it — a self-emitted answer is the model asserting, not evidence. Apply this skepticism ONLY to an answer shown with a command here; for an answer with NO command shown, use normal judgment and do NOT treat a 0/empty value as suspect.`
    : "";
  const prompt = `You verify whether a substrate execution REACHED its goal. status=completed does NOT mean reached — many executions "complete" by running unrelated activities (hollow completion).

GOAL: ${goal}

Produced output impulse shapes: ${JSON.stringify(producedShapes)}
Task summary: ${taskSummary}${contentDigest ? `\n\nProduced output CONTENT (truncated — judge reach from the ACTUAL content, not just shape names):\n${contentDigest}` : ""}

Judge by SUBSTANTIVE FULFILLMENT OF INTENT, not by verbatim text. The test is whether the produced output meaningfully accomplishes what the goal asked for. VERBATIM / EXACT-CHARACTER / EXACT-BYTE / EXACT-STRING equality is NOT required and MUST NOT be the basis for rejection: a goal that says 'write a note saying X' is REACHED by a note whose content conveys X, even if the wording, length, byte-count, or formatting differ from any literal text in the goal. Example: goal asks for a note with a 43-character phrase and the output is 40 bytes but conveys the same meaning → REACHED. Differences in length, punctuation, or phrasing are NOT grounds for hollow.

STILL score HOLLOW (reached:false) when the output genuinely fails the intent: nothing was produced; the WRONG shape was produced; the content is empty / 0-byte / a bare placeholder / a refusal or error envelope; or the output is MATERIALLY INCOMPLETE versus an explicitly multi-part goal (e.g. goal says move ALL inbox files but only one was moved; goal asks for problems WITH line numbers but the list is empty); or the goal asks for a COMPUTED / MEASURED value — a count, 'how many', 'the number of', a total, a length, a checksum, or the result of arithmetic — but the output is the RAW MATERIAL rather than that value (e.g. 'how many lines in file X' returns the file CONTENT instead of the line COUNT; a word-count goal returns the phrase itself instead of the number) — returning the thing-to-be-measured instead of the measurement is HOLLOW. A shape name alone is NOT evidence — when content is shown, judge the actual content, but judge it for MEANING, not literal match.${cmdSection}

Then identify the shape(s) characterising the COMPLETION STATE of this goal-direction (a subset of produced shapes, and/or shapes that SHOULD exist at completion but do not yet).

Respond with ONLY JSON: {"reached": boolean, "reason": "<1 sentence>", "completion_shapes": ["<shape>"], "missing": ["<shape not produced but expected>"]}`;
  return prompt;
}

/** Parse and sanitise the judge's reply. Throws on unparseable JSON (the caller treats that as null). */
export function parseReachJudgeText(text: unknown): ReachJudgeVerdict | null {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  const p: any = JSON.parse(m[0]);
  // SANITIZE — reason/deterministic are LLM-writable; whitelist fields and FORCE
  // deterministic:false so a model-injected {"deterministic":true} or a "deterministic:"-
  // prefixed reason can NEVER reach isSubstanceHonestReach. Only CODE sets the flag
  // (favorable-compose :876). Credit thus never fires on a bare LLM-yes (the reach judge
  // rubber-stamps some trivial/impossible goals: negative_control reached 3/3).
  const negationPhrases = ["did not provide", "does not contain", "did not contain", "not provided", "but the output", "no output", "lacks", "failing to"];
  const reason = String(p.reason ?? "").replace(/^\s*deterministic:/i, "llm-claimed:");
  const hasNegation = negationPhrases.some((phrase) => reason.includes(phrase));
  return {
    reached: !!(p.reached && !hasNegation),
    reason,
    completion_shapes: Array.isArray(p.completion_shapes) ? p.completion_shapes.map(String) : [],
    missing: Array.isArray(p.missing) ? p.missing.map(String) : [],
    deterministic: false,
  };
}

/** The LLM reach judge: prompt, model call, sanitised verdict. null = the judge could not be consulted. */
export async function judgeReach(input: ReachJudgeInput, complete: ReachJudgeComplete): Promise<ReachJudgeVerdict | null> {
  const { goal, producedShapes, taskSummary, contentDigest, commandEvidence } = input;
  const prompt = buildReachJudgePrompt(goal, producedShapes, taskSummary, contentDigest, commandEvidence);
  try {
    const text = await complete(prompt);
    if (text === null) return null;
    return parseReachJudgeText(text);
  } catch { return null; }
}
