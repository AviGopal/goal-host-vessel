/**
 * THE LLM REACH JUDGE'S DECISION, OUT OF index.ts SO IT CAN BE TESTED.
 *
 * Moved VERBATIM from `llmJudgeReach` (index.ts): the judge prompt, and the parse + sanitise of the
 * judge's reply (negation phrases, `deterministic` forced false, `deterministic:` reason prefix
 * rewritten). index.ts keeps only the routing (routedComplete, reach_verification) and passes it in
 * as `complete`, so a test can stand in for the model. Importing index.ts boots the host, so the
 * judge was unreachable from a unit test until now.
 *
 * GROUNDING GATES (gap the-llm-reach-judge-accepts-ungrounded-answers-to-current-information-and-
 * self-description-goals). Held-out probes measured the judge granting reach to a current-information
 * goal answered by one llm_completion_dispatch step with no source (template text, or a fabricated
 * stale "today"), to self-description goals answered with the backing model's persona, and to a
 * hedge that commits to nothing. Prose in the judge prompt has not held for this class (8a85cfa,
 * 2c26fcb), so `groundingPreGate` decides these DETERMINISTICALLY before the model is asked; it only
 * ever says not-reached or abstains, and the judge decides everything that survives it. The run date
 * is also put into the judge prompt (gap reach-judge-and-synthesis-lack-the-current-date…), the same
 * host-clock block synthesis reads — a context fact, never the check.
 *
 * Every rule reads the chain's SHAPES (roles below) and the ANSWER text only; the cue lists are the
 * named exported constants, kept here so they are reviewable in one place.
 */
import { ANSWER_SHAPES, assertedDatesInText, digestSegments, isStaleDate, temporalGroundingBlock, timeRelativeOffset } from "./reach-date";

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
  const now = input.now ?? new Date();
  const gated = groundingPreGate({ ...input, now });
  if (gated) return gated;
  const prompt = temporalGroundingBlock(now) + buildReachJudgePrompt(goal, producedShapes, taskSummary, contentDigest, commandEvidence);
  try {
    const text = await complete(prompt);
    if (text === null) return null;
    return parseReachJudgeText(text);
  } catch { return null; }
}

// ── Grounding gates ─────────────────────────────────────────────────────────────────────────────

/** Goals that need information about the world NOW. A heuristic cue list (flagged): "now" alone is
 *  NOT in it ("now explain …"). "current"/"latest" also hit questions about the substrate's own
 *  state ("the latest commit touching repos/…"); those are not blocked, because the source rule
 *  below accepts ANY non-LLM producer as a source, so a shell/file/registry read passes to the judge. */
export const CURRENT_INFORMATION_CUES = /\b(?:today'?s?|tonight|yesterday'?s?|right now|at the moment|currently|current|latest|this (?:week'?s?|month'?s?|morning|afternoon|evening)|news|headlines?|breaking)\b/i;

/** Goals asking the substrate to describe ITSELF (the deictic "you"/"this system"). */
export const SELF_DESCRIPTION_CUES = /\b(?:what|who) are you\b|\bdescribe yourself\b|\btell me about yourself\b|\bintroduce yourself\b|\bwhat can you do\b|\bwhat(?: is|'s) this (?:system|substrate)\b|\bwhat (?:this|the) (?:system|substrate) is\b/i;

/** Producers of the substrate's knowledge about itself, as the live registry names them (the set the
 *  wrong-subject gap lists; "registry" is read through a shell call, matched by REGISTRY_READ_RE). */
export const SELF_KNOWLEDGE_SHAPES: ReadonlySet<string> = new Set([
  "shape_producer_inventory", "learned_topology_snapshot", "substrate_health_tick", "self_fact_reconcile",
  "memoryNote", "docs_align_scan", "vessel_health_report", "vessel_completeness_report", "topologyCoverage",
  "substrateBootstrap", "substrateObservable", "discovery_vessel_registry_observer",
]);
/** A command that read the discovery registry (/registry, /registry/stats, /registry/shapes). */
const REGISTRY_READ_RE = /\/registry\b/;

/** Sentences that commit to nothing: a hedge, a request to clarify, or an offer instead of an answer.
 *  A sentence is non-committal when it matches this OR ends in "?". Heuristic phrase list (flagged). */
export const NON_ANSWER_PHRASES = /\b(?:it|that|this|the answer) (?:really )?depends\b|\bdepends (?:on|entirely)\b|\b(?:could|can) you (?:clarify|specify|tell me|provide|share|give me)\b|\bplease (?:clarify|specify|provide|let me know)\b|\blet me know\b|\bwould you like (?:me|to)\b|\bi (?:can|could) (?:fetch|look|search|check|find|help|provide|get)\b|\bi (?:do not|don't) have (?:access|real-time|the ability|browsing|internet)\b|\bas an ai\b/i;

/** LLM writers: their output is the answer, never a source. */
const LLM_WRITER_SHAPES: ReadonlySet<string> = new Set([...ANSWER_SHAPES, "llm_completion_dispatch"]);
/** Dispatch seeds and placeholders: present in every chain, evidence of nothing. */
const SEED_SHAPES: ReadonlySet<string> = new Set(["goal", "dispatch_id", "universal_fallback_result"]);
/** The floor's own testimony that it executed no tool (index.ts universalToolFallback). */
const ZERO_TOOLS_BANNER = "[GROUNDING: ZERO tools were executed";
const FLOOR_OBSERVATIONS_MARKER = "\n--- grounded tool outputs ---";

/** The text inside a dispatcher envelope ({"success":true,"shape":"llmTextCompletion","body":{"text":…}}). */
function unwrapAnswer(raw: string): string {
  const t = raw.trim();
  const pick = (o: any): string | null => {
    if (typeof o === "string") return o;
    if (!o || typeof o !== "object") return null;
    for (const k of ["text", "content", "answer"]) if (typeof o[k] === "string") return o[k];
    return o.body !== undefined ? pick(o.body) : null;
  };
  try { const v = pick(JSON.parse(t)); if (v !== null) return v; } catch { /* truncated or not JSON */ }
  const m = t.match(/"(?:text|content|answer)"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]!.replace(/\\n/g, "\n"); } }
  return t;
}

/** The answer texts of a digest: labelled LLM-writer segments; for an unlabelled digest (the floor)
 *  the authored part — banner removed, tool observations cut. */
export function answerTexts(digest: string): string[] {
  const segs = digestSegments(digest);
  if (segs.length > 0 && segs.every((s) => s.shape === null)) {
    let t = digest.startsWith(ZERO_TOOLS_BANNER) ? digest.slice(digest.indexOf("]") + 1) : digest;
    const cut = t.indexOf(FLOOR_OBSERVATIONS_MARKER);
    if (cut >= 0) t = t.slice(0, cut);
    return t.trim() ? [t.trim()] : [];
  }
  return segs.filter((s) => s.shape !== null && LLM_WRITER_SHAPES.has(s.shape)).map((s) => unwrapAnswer(s.text)).filter((t) => t.trim().length > 0);
}

/** Non-answer: EVERY clause of the answer is non-committal (NON_ANSWER_PHRASES, or a question).
 *  Clauses are sentences, further split at "but" and ";", so "it depends on X, but Y is the better
 *  default" commits (its second clause asserts something) while "it depends on your needs" does not. */
export function isNonAnswer(answer: string): boolean {
  const clauses = answer.replace(/[*_#>`]/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .flatMap((x) => { const q = x.trim().endsWith("?"); return x.split(/,?\s+but\s+|;\s*/i).map((c) => (q ? `${c.trim().replace(/[.!?]$/, "")}?` : c.trim())); })
    .filter((x) => /[A-Za-z0-9]/.test(x));
  return clauses.length > 0 && clauses.every((x) => x.endsWith("?") || NON_ANSWER_PHRASES.test(x));
}

/** Did the chain consult any source in-run? Any produced shape that is not an LLM writer, a seed or a
 *  write; never when the floor testifies it ran zero tools. */
export function hasInRunSource(producedShapes: string[], digest: string): boolean {
  if (digest.trimStart().startsWith(ZERO_TOOLS_BANNER)) return false;
  return producedShapes.some((s) => !LLM_WRITER_SHAPES.has(s) && !SEED_SHAPES.has(s) && !/_write$/.test(s));
}

const DAY_MS = 86_400_000;
const notReached = (code: string, why: string): ReachJudgeVerdict => ({
  reached: false, deterministic: true, completion_shapes: [], reason: `deterministic:${code} — ${why}`,
});

/**
 * The deterministic gates in front of the LLM judge. Returns not-reached or null (abstain: the judge
 * decides). Rules, in order:
 *  1. NON-ANSWER: every clause of the answer is a hedge, a request to clarify, an offer, or a question.
 *     Goals that ask for questions (ask / question…) are exempt: all-question output is their deliverable.
 *  2. UNSOURCED CURRENT INFORMATION: a CURRENT_INFORMATION_CUES goal whose chain has no in-run source.
 *  3. STALE TODAY: a current-information answer asserting a current/report date ("Today is …",
 *     "Today, …", a leading "As of …") off the run clock (±1 day, after the goal's yesterday/tomorrow
 *     offset). Other dates in the answer (yesterday's items, history) are not read.
 *  4. WRONG SUBJECT: a SELF_DESCRIPTION_CUES goal whose chain used no SELF_KNOWLEDGE_SHAPES producer and
 *     read no registry.
 */
export function groundingPreGate(input: ReachJudgeInput & { now: Date }): ReachJudgeVerdict | null {
  const { goal, producedShapes, now } = input;
  const digest = (input.contentDigest ?? "").trim();
  const answers = answerTexts(digest);

  if (!/\b(?:ask|question)/i.test(goal) && answers.length > 0 && answers.every(isNonAnswer)) {
    return notReached("non-answer", "every clause of the answer is a hedge, a request to clarify, an offer or a question; it commits to no answer");
  }

  if (CURRENT_INFORMATION_CUES.test(goal)) {
    if (!hasInRunSource(producedShapes, digest)) {
      return notReached("unsourced-current-information", `the goal asks for current information and the chain consulted no source in-run (produced: ${producedShapes.join(", ") || "none"}); an answer from model memory cannot be current`);
    }
    const target = new Date(now.getTime() + (timeRelativeOffset(goal) ?? 0) * DAY_MS);
    const stale = answers.flatMap(assertedDatesInText).filter((d) => isStaleDate(d, target));
    if (stale.length > 0) {
      return notReached("stale-asserted-date", `the answer asserts "${stale[0]!.text.trim()}" as the current/report date; the run clock reads ${now.toISOString().slice(0, 10)} (target ${target.toISOString().slice(0, 10)}, ±1 day)`);
    }
  }

  if (SELF_DESCRIPTION_CUES.test(goal)) {
    const selfKnown = producedShapes.some((s) => SELF_KNOWLEDGE_SHAPES.has(s)) || REGISTRY_READ_RE.test(input.commandEvidence ?? "");
    if (!selfKnown) {
      return notReached("ungrounded-self-description", `the goal asks the substrate to describe itself and the chain consulted no self-knowledge producer (${[...SELF_KNOWLEDGE_SHAPES].slice(0, 4).join(", ")}, …) and read no registry; a model's own persona is the wrong subject`);
    }
  }
  return null;
}
