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
import { SEARCH_RESULT_SHAPES } from "./grounded-report";
import { isFsWriteShape } from "./fs-write-shapes";
import { CHANGE_PRIMITIVE_SHAPES } from "./write-door";

export interface ReachJudgeInput {
  goal: string;
  producedShapes: string[];
  taskSummary: string;
  contentDigest?: string;
  commandEvidence?: string;
  /** The run clock (injected in tests; the host clock otherwise). */
  now?: Date;
  /** J2a: the dispatch has a REQUIRED input every derivation failed for (needs-information.ts), a structural fact. */
  needsInformation?: boolean;
  /** The goal's target shapes that THIS substrate's own vessels serve and in the read role (isReadRoleShape),
   *  resolved by the caller through discovery at use time (index.ts ownLocalTargets). Non-empty makes the goal a
   *  question about this system's own state, whatever its words (rule 5). */
  localTargets?: string[];
}

/** Structurally a GoalReachVerdict (index.ts). */
export interface ReachJudgeVerdict {
  reached: boolean;
  reason: string;
  completion_shapes: string[];
  missing?: string[];
  deterministic: boolean;
  /** The judge's reading of what the goal is ABOUT: the system answering it, or anything else; null when the reply named
   *  neither. Set on every verdict the judge decided (and on the refusal it causes), so the record can count refusals
   *  of general goals the judge read as this_system. It only ever refuses (judgeReach: a this_system goal whose chain
   *  consulted nothing). Absent on a verdict a gate decided before the judge. */
  subject?: "this_system" | "other" | null;
  /** Set only when a gate that SHADOWS the judge decided (the local-state rule): what the judge said, recorded, never used. */
  judge_verdict_before_pregate?: { reached: boolean | null; reason: string };
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

Also name the goal's SUBJECT: "this_system" when it asks about the system that ran it (its own state, identity, capabilities, files or filesystem, processes, configuration, network or stores), including a goal that says "the filesystem", "your …" or "this system" and names no other system; "other" for general knowledge, a named third party, or the outside world. The subject does not change your reached verdict.

Respond with ONLY JSON: {"reached": boolean, "reason": "<1 sentence>", "completion_shapes": ["<shape>"], "missing": ["<shape not produced but expected>"], "subject": "this_system" | "other"}`;
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
    subject: p.subject === "this_system" || p.subject === "other" ? p.subject : null,
  };
}

/** The LLM reach judge: prompt, model call, sanitised verdict. null = the judge could not be consulted.
 *  `shadowComplete` is the model call for a SHADOW consultation (a gate that decided records what the judge said):
 *  the caller routes it so it is never rewarded (index.ts: SHADOW_ROUTE_PREFIX). Absent, `complete` is used. */
export async function judgeReach(input: ReachJudgeInput, complete: ReachJudgeComplete, shadowComplete?: ReachJudgeComplete): Promise<ReachJudgeVerdict | null> {
  const now = input.now ?? new Date();
  const gated = groundingPreGate({ ...input, now });
  // The local-state rule is new, and an answer from the agentic llm_completion_dispatch wrapper can rest on tool reads
  // that surface no shape (hasInRunSource), so the judge is still asked IN SHADOW: its verdict is recorded beside the
  // gate's, never used, which measures how often this gate overrides it. The older gates do not call the judge.
  if (gated && gated.reason.startsWith(`deterministic:${LOCAL_STATE_CODE} `)) {
    return { ...gated, judge_verdict_before_pregate: judgeShadowOf(await judgeModelOnly(input, shadowComplete ?? complete)) };
  }
  if (gated) return gated;
  // A SELF-QUESTION WITH NO TARGET TO CLASSIFY IT (rule 5 reads the targets; an explanatory question is routed to an
  // answer shape, so localTargets is empty). The judge's subject names it; whether the chain consulted anything is code.
  // Subject this_system + nothing consulted ⇒ not reached under rule 5's code, the judge's verdict recorded beside it.
  const v = await judgeModelOnly(input, complete);
  if (v?.reached && v.subject === "this_system" && !consultedInRun(input.producedShapes, input.commandEvidence, input.contentDigest)) {
    return {
      ...notReached(LOCAL_STATE_CODE, `the judge reads the goal as about this system, and the chain consulted nothing in-run (produced: ${input.producedShapes.join(", ") || "none"}; no registry read; no tool run by the answering model); an answer from model memory describes some other system`),
      subject: v.subject,
      judge_verdict_before_pregate: judgeShadowOf(v),
    };
  }
  return v;
}

/** The model's own verdict: the prompt and the sanitised reply, with NO grounding gate in front. This is what a shadow
 *  records — gating the shadow would record a gate's verdict (e.g. this file's own local-state rule on a goal that a
 *  stated-bound oracle decided) instead of the judge's. */
export async function judgeModelOnly(input: ReachJudgeInput, complete: ReachJudgeComplete): Promise<ReachJudgeVerdict | null> {
  const { goal, producedShapes, taskSummary, contentDigest, commandEvidence } = input;
  const prompt = temporalGroundingBlock(input.now ?? new Date()) + buildReachJudgePrompt(goal, producedShapes, taskSummary, contentDigest, commandEvidence);
  try {
    const text = await complete(prompt);
    if (text === null) return null;
    return parseReachJudgeText(text);
  } catch { return null; }
}

// ── Full read (reach condition 5: full view or abstain) ──────────────────────────────────────────

/** Where one part sits in the whole deliverable (judge-view.ts judgeViewParts). */
export interface ReachJudgePart { k: number; n: number; from: number; to: number; total: number }
/** One part's answer, exactly one of three: SUPPORTS (this part shows the goal met), REFUTES (it shows the goal not
 *  met), NEUTRAL (neither: a middle part that merely does not hold the answer). */
export type ReachJudgePartOutcome = "supports" | "refutes" | "neutral";
export interface ReachJudgePartVerdict { verdict: ReachJudgePartOutcome; reason: string; completion_shapes: string[]; missing: string[] }
/** A full read's result. `undecided`: every part read was NEUTRAL, so nothing in the deliverable decided the reach —
 *  the caller grades it as an abstain (cut-view), never as not-reached. */
export type ReachJudgeFullReadVerdict = ReachJudgeVerdict & { undecided?: true };

/**
 * The judge's question for ONE ordered part of a deliverable too large for its view. NOT the whole-view prompt: that
 * one scores a view HOLLOW when it is "materially incomplete", which a middle part read alone always is, and its
 * parser flips any reason saying "lacks"/"does not contain" to not-reached, the words a judge uses for a part that
 * does not hold the conclusion. Either way the AND over parts would grade good work hollow and charge it β. So a
 * part answers exactly one of SUPPORTS / REFUTES / NEUTRAL, and a part that merely lacks the answer is NEUTRAL.
 */
export function buildReachJudgePartPrompt(goal: string, producedShapes: string[], taskSummary: string, part: ReachJudgePart, partDigest: string, commandEvidence?: string): string {
  const cmdSection = commandEvidence
    ? `\n\nCOMMANDS THAT PRODUCED THE OUTPUT (judge command<->intent alignment; a command that does not accomplish what the goal asks, or merely echoes a literal answer, REFUTES the reach):\n${commandEvidence}`
    : "";
  return `You verify whether a substrate execution REACHED its goal. Its deliverable is too large to show at once (${part.total} chars), so it is read in ${part.n} ORDERED PARTS, each judged separately. You are reading PART ${part.k} of ${part.n} (chars ${part.from}-${part.to} of ${part.total}).

GOAL: ${goal}

Produced output impulse shapes: ${JSON.stringify(producedShapes)}
Task summary: ${taskSummary}

PART ${part.k} of ${part.n} of the produced output CONTENT (followed by the run's evidence lines):
${partDigest}${cmdSection}

Classify THIS PART as EXACTLY ONE of three, judging MEANING, not verbatim text:
- "refutes": this part shows the goal was NOT met. The content here is wrong or contradicts what the goal asks, reports a failure or a result opposite to what is claimed elsewhere, or is an error envelope, a refusal or a bare placeholder where the asked-for content should be.
- "supports": this part contains content that substantively accomplishes what the goal asked for. Raw material where the goal asks for a computed or measured value (a count, a total, a length, a checksum) does not support it.
- "neutral": neither. A part that merely does not hold the answer (filler, context, the middle of a log) is NEUTRAL: content that is simply not in this part is NOT a refutation, because the other parts are read separately.

Respond with ONLY JSON: {"verdict": "supports" | "refutes" | "neutral", "reason": "<1 sentence naming what in this part decided it>", "completion_shapes": ["<shape>"], "missing": ["<shape not produced but expected>"]}`;
}

/** Parse one part's reply: `verdict` must be exactly "supports", "refutes" or "neutral", anything else is unparseable
 *  (null: the caller's re-call channel). Like parseReachJudgeText it whitelists fields and rewrites a model-written
 *  "deterministic:" reason prefix; unlike it, there is no negation flip (a neutral part's reason names what it lacks). */
export function parseReachJudgePartText(text: unknown): ReachJudgePartVerdict | null {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  const p: any = JSON.parse(m[0]);
  if (p.verdict !== "supports" && p.verdict !== "refutes" && p.verdict !== "neutral") return null;
  return {
    verdict: p.verdict,
    reason: String(p.reason ?? "").replace(/^\s*deterministic:/i, "llm-claimed:"),
    completion_shapes: Array.isArray(p.completion_shapes) ? p.completion_shapes.map(String) : [],
    missing: Array.isArray(p.missing) ? p.missing.map(String) : [],
  };
}

const partAt = (p: ReachJudgePart) => `part ${p.k}/${p.n} (chars ${p.from}-${p.to} of ${p.total})`;

/** The conservative AND over the parts read, in order: any REFUTING part ⇒ not reached, citing it; else any SUPPORTING
 *  part ⇒ reached, citing it; else (all NEUTRAL) undecided — an abstain for the caller, never not-reached. Never
 *  deterministic: this is the LLM judge reading more. */
export function combinePartVerdicts(read: ReadonlyArray<{ part: ReachJudgePart; verdict: ReachJudgePartVerdict }>): ReachJudgeFullReadVerdict {
  const n = read[0]?.part.n ?? 0, total = read[0]?.part.total ?? 0;
  const refuting = read.find((r) => r.verdict.verdict === "refutes");
  const missing = [...new Set(read.flatMap((r) => r.verdict.missing))];
  if (refuting) return { reached: false, reason: `full-read: ${partAt(refuting.part)} refutes the reach — ${refuting.verdict.reason}`, completion_shapes: [], missing, deterministic: false };
  const supporting = read.filter((r) => r.verdict.verdict === "supports");
  if (supporting.length === 0) return { reached: false, undecided: true, reason: `full-read: all ${n} parts read (${total} chars) and every part is neutral — none supports or refutes the reach`, completion_shapes: [], missing, deterministic: false };
  return {
    reached: true,
    reason: `full-read: all ${n} parts read (${total} chars), none refutes, and ${supporting.map((r) => partAt(r.part)).join(", ")} support${supporting.length === 1 ? "s" : ""} the reach — ${supporting[0]!.verdict.reason}`,
    completion_shapes: [...new Set(supporting.flatMap((r) => r.verdict.completion_shapes))],
    missing,
    deterministic: false,
  };
}

/** The full read: the grounding gates once over the WHOLE deliverable (input.contentDigest), then each part in order,
 *  stopping at the first that refutes. null = the judge could not be consulted for some part, or answered outside the
 *  three verdicts (the caller's "verdict unknown" channel): a verdict over a subset of the parts is not a verdict over
 *  the deliverable. */
export async function judgeReachInParts(input: ReachJudgeInput, parts: ReadonlyArray<ReachJudgePart & { digest: string }>, complete: ReachJudgeComplete): Promise<ReachJudgeFullReadVerdict | null> {
  const now = input.now ?? new Date();
  const gated = groundingPreGate({ ...input, now });
  if (gated) return gated;
  const read: Array<{ part: ReachJudgePart; verdict: ReachJudgePartVerdict }> = [];
  for (const p of parts) {
    let verdict: ReachJudgePartVerdict | null;
    try {
      const text = await complete(temporalGroundingBlock(now) + buildReachJudgePartPrompt(input.goal, input.producedShapes, input.taskSummary, p, p.digest, input.commandEvidence));
      if (text === null) return null;
      verdict = parseReachJudgePartText(text);
    } catch { return null; }
    if (!verdict) return null;
    read.push({ part: { k: p.k, n: p.n, from: p.from, to: p.to, total: p.total }, verdict });
    if (verdict.verdict === "refutes") break;
  }
  return read.length > 0 ? combinePartVerdicts(read) : null;
}

/** A shadow verdict as recorded: reached null = the judge could not be consulted. */
export function judgeShadowOf(v: { reached: boolean; reason?: string } | null): { reached: boolean | null; reason: string } {
  return v ? { reached: v.reached, reason: v.reason ?? "" } : { reached: null, reason: "the judge could not be consulted" };
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

const LOCAL_STATE_CODE = "unsourced-local-state";

/** Sentences that commit to nothing: a hedge, a request to clarify, or an offer instead of an answer.
 *  A sentence is non-committal when it matches this OR ends in "?". Heuristic phrase list (flagged). */
export const NON_ANSWER_PHRASES = /\b(?:it|that|this|the answer) (?:really )?depends\b|\bdepends (?:on|entirely)\b|\b(?:could|can) you (?:clarify|specify|tell me|provide|share|give me)\b|\bplease (?:clarify|specify|provide|let me know)\b|\blet me know\b|\bwould you like (?:me|to)\b|\bi (?:can|could) (?:fetch|look|search|check|find|help|provide|get)\b|\bi (?:do not|don't) have (?:access|real-time|the ability|browsing|internet)\b|\bas an ai\b/i;

/** LLM writers: their output is the answer, never a source. */
const LLM_WRITER_SHAPES: ReadonlySet<string> = new Set([...ANSWER_SHAPES, "llm_completion_dispatch"]);
/** Dispatch seeds and placeholders: present in every chain, evidence of nothing. */
const SEED_SHAPES: ReadonlySet<string> = new Set(["goal", "dispatch_id", "universal_fallback_result"]);
/** The floor's banner (index.ts universalToolFallback): stripped from the answer text, never read as evidence. */
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
 *  write. SHAPES ONLY: the floor's "[GROUNDING: ZERO tools were executed" banner is the floor's own
 *  self-report, and it is wrong for the agentic llm_completion_dispatch wrapper, which runs its tools
 *  internally and reports none (a replay over node 1's verdicts since 09-26 found it refusing 10
 *  substrate-state answers that cited real query results). No rule reads it. */
export function hasInRunSource(producedShapes: string[]): boolean {
  return producedShapes.some((s) => !LLM_WRITER_SHAPES.has(s) && !SEED_SHAPES.has(s) && !/_write$/.test(s));
}

/** A shape in the READ role: not an LLM writer, a seed, a search, or a write (a `_write` shape, a filesystem write,
 *  FS_WRITE_SHAPES, or a change primitive, write-door.ts CHANGE_PRIMITIVE_SHAPES). Derived from the existing role sets;
 *  no shape is named here. A write a resolver performs under an undeclared name still reads as a read (the
 *  declared-write-metadata gap: writes are not declared in resolver metadata, so no set can be complete). */
export function isReadRoleShape(s: string): boolean {
  return !LLM_WRITER_SHAPES.has(s) && !SEED_SHAPES.has(s) && !SEARCH_RESULT_SHAPES.has(s)
    && !/_write$/.test(s) && !isFsWriteShape(s) && !CHANGE_PRIMITIVE_SHAPES.has(s);
}

/** The external origins a content blob names: the same canonicalisation as the effect tuple's externals (index.ts
 *  effectTupleOf), less loopback, which is this host. */
export function externalOriginsOf(content: string): string[] {
  const canon = (u: string): string => {
    const m = /^https?:\/\/([^/\s"']+)(\/[A-Za-z0-9_.\-]*)?/.exec(u);
    if (!m) return "";
    const seg = (m[2] ?? "").replace(/^\//, "").split(/[.?#]/)[0] ?? "";
    return `${m[1]}${seg ? "/" + seg : ""}`;
  };
  const isLoopback = (o: string) => /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(o);
  return [...new Set((content.match(/https?:\/\/[^\s"'\\)]+/g) ?? []).map(canon).filter((o) => o && !isLoopback(o)))].sort();
}

/** Did the chain read THIS system in-run? A produced read-role shape (isReadRoleShape) that is not a WORLD FETCH (its
 *  digest content names an external origin, externalOriginsOf), on the floor including the read tools it EXECUTED
 *  (index.ts floorJudgedShapes), or a command that read the registry. */
export function hasLocalRead(producedShapes: string[], commandEvidence?: string, contentDigest?: string): boolean {
  const external = new Set<string>();
  for (const seg of digestSegments(contentDigest ?? "")) if (seg.shape && externalOriginsOf(seg.text).length > 0) external.add(seg.shape);
  return producedShapes.some((s) => isReadRoleShape(s) && !external.has(s)) || REGISTRY_READ_RE.test(commandEvidence ?? "");
}

/** Did the chain consult ANYTHING in-run? A source shape (hasInRunSource), a command that read the registry, or a tool
 *  the answering model ran itself: `body.executed_tool_calls` in an LLM writer's envelope (the agentic dispatch wrapper
 *  runs its tools internally and surfaces no shape; absent means none, as index.ts executedToolCallsOf reads it). An
 *  LLM writer's segment that is not a whole envelope (cut, or plain text) is unknown, and unknown counts as consulted. */
export function consultedInRun(producedShapes: string[], commandEvidence?: string, contentDigest?: string): boolean {
  if (hasInRunSource(producedShapes) || REGISTRY_READ_RE.test(commandEvidence ?? "")) return true;
  const ranTools = (text: string): boolean => {
    let o: any;
    try { o = JSON.parse(text.trim()); } catch { return true; }
    if (!o || typeof o !== "object") return true;
    const raw = o.body?.executed_tool_calls ?? o.content?.body?.executed_tool_calls ?? o.executed_tool_calls;
    return Array.isArray(raw) && raw.length > 0;
  };
  return digestSegments(contentDigest ?? "").some((seg) => seg.shape !== null && LLM_WRITER_SHAPES.has(seg.shape) && ranTools(seg.text));
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
 *  5. UNSOURCED LOCAL STATE: a goal whose targets are local reads THIS substrate's own vessels serve (localTargets,
 *     resolved through discovery by the caller: STRUCTURAL, no word list) and whose chain made no local read
 *     (hasLocalRead). A walk aimed at no local shape is not a local-state question, whatever its words. The judge
 *     is consulted in shadow for this rule (judgeReach).
 *  After the judge (judgeReach, not here): a reached verdict whose judge names the goal's subject this_system, on a
 *  chain that consulted nothing in-run (consultedInRun), is not reached under rule 5's code.
 */
export function groundingPreGate(input: ReachJudgeInput & { now: Date }): ReachJudgeVerdict | null {
  const { goal, producedShapes, now } = input;
  const digest = (input.contentDigest ?? "").trim();
  const answers = answerTexts(digest);

  // J2a: a hedging answer from a dispatch that NEEDS INFORMATION (a required input no derivation found) is graded as
  // that, not as a wrong answer: still NOT reached (it never flips to reached), with the shaped reason.
  // The same structural test the current-information rule uses (hasInRunSource): a dispatch that NEEDS INFORMATION and
  // consulted no source in-run has nothing its answer could rest on, whatever that answer says.
  if (input.needsInformation === true && ((answers.length > 0 && answers.every(isNonAnswer)) || !hasInRunSource(producedShapes))) {
    return notReached("needs-information", "the dispatch could not derive a required input (pool bind and investigation both found nothing), and its answer is a hedge or rests on no source consulted in-run; not reached, graded as an information request rather than a wrong answer");
  }
  // NAMED DEBT: the wording exemption below (gap the-non-answer-gate-exempts-clarifying-answers-by-goal-wording).
  if (!/\b(?:ask|question)/i.test(goal) && answers.length > 0 && answers.every(isNonAnswer)) {
    return notReached("non-answer", "every clause of the answer is a hedge, a request to clarify, an offer or a question; it commits to no answer");
  }

  if (CURRENT_INFORMATION_CUES.test(goal)) {
    if (!hasInRunSource(producedShapes)) {
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

  const localTargets = input.localTargets ?? [];
  // Fires only when the chain produced none of the local targets and made no local read: a walk that produced its
  // target (whatever that target's content) has answered from it.
  if (localTargets.length > 0 && !localTargets.some((t) => producedShapes.includes(t)) && !hasLocalRead(producedShapes, input.commandEvidence, input.contentDigest)) {
    return notReached(LOCAL_STATE_CODE, `the goal targets ${localTargets.slice(0, 4).join(", ")}, served by this substrate's own vessels, and the chain made no local read (produced: ${producedShapes.join(", ") || "none"}); an answer from model memory describes some other system`);
  }
  return null;
}
