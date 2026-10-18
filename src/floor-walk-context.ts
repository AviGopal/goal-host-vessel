/**
 * J1: THE FLOOR SEES THE WALK (design J1-J4.md; RUN 1R judge-graded misses).
 *
 * Measured: universalToolFallback built its prompt from the goal plus a learned recipe, a code-search seed and a
 * multi-quantity note ONLY. At the post-walk call site the walk's carried impulses (what real producers already returned
 * in this dispatch), its not-reached reason and the goal's prior failure feedback were all in scope and never passed, so
 * the floor re-derived from nothing what the walk had already measured, and repeated failures the substrate had recorded.
 * FAILURE-RECALL reached only the walks. Nothing was removed: the floor (1cf0b96) never had the walk's state.
 *
 * This renders that state as OBSERVATIONS the model must ground on, with the same discipline as the recipe seed: they are
 * tool results gathered in this dispatch, not an answer to repeat. It reuses the walk's own renderers: findingsDigest for
 * the carried impulses (the block a terminal writer binds) and the prior-failure feedback text the walks already receive.
 */
import { findingsDigest, type CarriedStep } from "./walk-pool";
import type { FailedReplay } from "./reached-command-store";

export interface FloorWalkContext {
  /** The walk's carry-forward (carryForward over its pool): impulses real producers returned in this dispatch. */
  carry?: readonly CarriedStep[];
  /** Why the walk ended without reaching (its goalReachReason). */
  reason?: string | null;
  /** The goal's prior-failure feedback (priorFailureFeedbackFor), the lessons the walks already receive. */
  priorFeedback?: string;
  /** The banked/recipe commands whose replay FAILED earlier in this dispatch (reached-command-store.ts), keyed by
   *  shape + command: the floor does not seed one of them as a verified measurement. */
  skipFailedReplays?: readonly FailedReplay[];
  /** The dispatch's structured variables.decompose_gap_id, carried explicitly like the dispatch id: the floor re-enters
   *  the dispatch context when its store is empty, and the reach gate inside the floor reads the field from there. */
  decomposeGapId?: string;
  /** The dispatch's learning mode, carried into the floor's own dispatch context (observe-mode.ts). */
  learningMode?: "observe" | "learn";
}

/**
 * The observations block appended to the floor prompt; "" when the walk left nothing to observe.
 * BOUNDED IN TOTAL by `maxChars` (selection-tuning floorObservationsMaxChars, read at use time), whatever the size of the
 * carry or of the goal's failure history: carried impulses are kept in CARRY ORDER until the budget is spent (gap
 * floor-observations-are-ordered-by-carry-order-not-impulse-relevance: goal-host reads no impulse-relevance posterior at
 * this site yet; owner the system, review_by 2026-10-24), then the walk's reason and the feedback lines fill what is
 * left. What did not fit is COUNTED in the block, so the model knows it saw a subset.
 */
export function floorObservationsBlock(ctx: FloorWalkContext | undefined, maxChars: number): string {
  if (!ctx) return "";
  let left = Math.max(0, maxChars);
  const kept: string[] = [];
  let omittedImpulses = 0;
  let omittedLines = 0;
  const impulses = (ctx.carry ?? []).flatMap((s) => s.impulses);
  for (const imp of impulses) {
    // findingsDigest renders one content-bearing impulse (it skips the goal impulse and empty or failed content).
    const one = findingsDigest([imp], new Set(["goal"])).text.replace(/^# Findings\n\n/, "");
    if (!one) continue;
    if (one.length <= left) { kept.push(one); left -= one.length; } else omittedImpulses++;
  }
  const parts: string[] = [];
  if (kept.length > 0) {
    parts.push(`OBSERVATIONS the walk already gathered in this dispatch (results real producers returned; ground your answer on them where they bear on the goal, and call your tools for anything they do not cover):\n${kept.join("\n\n")}`);
  }
  const reason = typeof ctx.reason === "string" ? ctx.reason.trim() : "";
  if (reason) {
    const line = `The walk that ran before you ended WITHOUT reaching the goal: ${reason}`;
    if (line.length <= left) { parts.push(line); left -= line.length; } else omittedLines++;
  }
  const fbLines = (ctx.priorFeedback ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const fbKept: string[] = [];
  for (const l of fbLines) { if (l.length <= left) { fbKept.push(l); left -= l.length; } else omittedLines++; }
  if (fbKept.length > 0) parts.push(`Earlier attempts at this goal failed as follows; do not repeat them:\n${fbKept.join("\n")}`);
  if (omittedImpulses + omittedLines > 0) {
    parts.push(`(${omittedImpulses} further observation(s) and ${omittedLines} further note(s) were omitted to keep this block within its size budget; you saw a subset.)`);
  }
  return parts.length === 0 ? "" : `\n\n${parts.join("\n\n")}`;
}
