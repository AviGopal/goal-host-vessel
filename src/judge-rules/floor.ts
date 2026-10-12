/**
 * THE FLOOR'S OWN DECISIONS: whether a floor (universal ReAct fallback) run reached, and whether a learned
 * floor pathway may be reused in place of a walk.
 *
 * Pure: the closed core (src/judge/) supplies the upstream verdict (the reach gate plus the closed oracles
 * and LLM judge) and the run's recorded evidence, and applies the closed floor clamps around these rules.
 */
import { goalRequestsDurableArtifact, isEditIntentGoal } from "../goal-intent";
import { goalRequiresArtifact, isMutationShape } from "./write-goal";
import type { FloorShortcutInput, JudgeEvidence, RecordedJudgeVerdict } from "../judge/records";
import type { RuleVerdict, ShortcutDecision } from "../judge/classes";

/** The answer narrates a tool call or response. */
const NARRATES_TOOL_USE = /\btool\s+(?:call|response|output|result)\b/i;

export interface FloorDecideInput {
  /** The upstream verdict after the closed clamps (null: no verdict was produced). */
  upstream: RecordedJudgeVerdict | null;
  answer_text: string;
  evidence: JudgeEvidence;
}

/**
 * A floor run reaches when the upstream verdict reached on a SUBSTANTIVE answer, grounded either by
 * client-executed tools (grounded reads > 0) or by an authored answer, unless:
 *   - the answer narrates a tool call/response but zero tools ran (a fabricated transcript); or
 *   - tools ran and every one of them failed.
 */
export function decide(i: FloorDecideInput): RuleVerdict & { fabricated_transcript: boolean } {
  const ev = i.evidence;
  const fabricated = NARRATES_TOOL_USE.test(i.answer_text) && ev.tools_total === 0;
  const upstreamReached = i.upstream?.reached === true;
  const substantive = ev.grounded_reads > 0 || i.answer_text.trim().length > 0;
  const allToolsFailed = ev.tools_total > 0 && ev.tools_ok === 0;
  const reached = upstreamReached && !fabricated && substantive && !allToolsFailed;
  if (reached) return { reached: true, hollow_class: null, reason_code: "floor:reached", deterministic: false, fabricated_transcript: false };
  if (!upstreamReached) return { reached: false, hollow_class: null, reason_code: "floor:upstream-not-reached", deterministic: false, fabricated_transcript: fabricated };
  if (fabricated) return { reached: false, hollow_class: "fabricated-tool-transcript", reason_code: "floor:fabricated-tool-transcript", deterministic: false, fabricated_transcript: true };
  if (allToolsFailed) return { reached: false, hollow_class: "floor-all-tools-failed", reason_code: "floor:all-tools-failed", deterministic: false, fabricated_transcript: false };
  return { reached: false, hollow_class: "floor-no-substance", reason_code: "floor:no-substance", deterministic: false, fabricated_transcript: false };
}

/**
 * The REUSE-BEFORE-DERIVE floor shortcut. The floor reads and reasons; it cannot land a commit or deliver
 * an artifact, so the shortcut serves question goals only:
 *   - the pathway is exactly the floor;
 *   - not an edit goal, not a durable-record goal, no mutation-shape target (a *_write target is a
 *     durable artifact on this side);
 *   - a BORROWED pathway (matched by shape signature from another goal) is never reused for a
 *     change/write goal; a goal's OWN pathway still serves its read goal.
 */
export function shortcutAllowed(i: FloorShortcutInput): ShortcutDecision {
  if (i.activities.length !== 1 || String(i.activities[0] ?? "") !== "universal-tool-fallback") return { allowed: false, reason_code: "shortcut:not-the-floor" };
  if (isEditIntentGoal(i.goal)) return { allowed: false, reason_code: "shortcut:edit-goal" };
  if (goalRequestsDurableArtifact(i.goal)) return { allowed: false, reason_code: "shortcut:durable-artifact-goal" };
  if (i.targets.some(isMutationShape)) return { allowed: false, reason_code: "shortcut:mutation-targets" };
  if (i.borrowed && goalRequiresArtifact(i.goal, i.targets)) return { allowed: false, reason_code: "shortcut:borrowed-for-change-goal" };
  return { allowed: true, reason_code: i.borrowed ? "shortcut:borrowed-for-read-goal" : "shortcut:own-pathway" };
}
