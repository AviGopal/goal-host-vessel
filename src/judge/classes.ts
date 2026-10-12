/**
 * THE CLOSED VOCABULARY OF THE JUDGE: the output schema the open rules must return, the hollow classes,
 * the reason codes and the credit classes. Adding a class or a code is a closed change: an open rule
 * cannot invent one, and the core refuses any output outside this vocabulary (src/judge/entries.ts).
 */

/** The hollow classes a verdict may carry. */
export const HOLLOW_CLASSES = [
  "write-goal-no-artifact",
  "zero-tool-write-claim",
  "fabricated-tool-transcript",
  "floor-all-tools-failed",
  "floor-no-substance",
  "floor-unverified-reach",
  "reframed-target",
  "judge-rules-refused",
] as const;
export type HollowClass = (typeof HOLLOW_CLASSES)[number];

/** The reason codes an open rule may return. The core renders the reason TEXT from the code. */
export const REASON_CODES = [
  "write-goal-gate:pass",
  "write-goal-no-artifact:change",
  "write-goal-no-artifact:write",
  "reframed-target",
  "floor:reached",
  "floor:upstream-not-reached",
  "floor:fabricated-tool-transcript",
  "floor:all-tools-failed",
  "floor:no-substance",
  "floor:unverified-reach",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const SHORTCUT_CODES = [
  "shortcut:not-the-floor",
  "shortcut:edit-goal",
  "shortcut:durable-artifact-goal",
  "shortcut:mutation-targets",
  "shortcut:borrowed-for-change-goal",
  "shortcut:borrowed-for-read-goal",
  "shortcut:own-pathway",
] as const;
export type ShortcutCode = (typeof SHORTCUT_CODES)[number];

export const REFRAME_CODES = [
  "reframe:accepted",
  "reframe:not-reached",
  "reframe:skipped-planned-retrieval",
  "reframe:raw-input-only",
  "reframe:punt-only",
] as const;
export type ReframeCode = (typeof REFRAME_CODES)[number];

/** EXACTLY what a verdict rule returns. Any extra key, a non-boolean or an unknown class/code is refused. */
export interface RuleVerdict {
  reached: boolean;
  hollow_class: HollowClass | null;
  reason_code: ReasonCode;
  deterministic: boolean;
}

export interface ShortcutDecision {
  allowed: boolean;
  reason_code: ShortcutCode;
}

export interface ReframeDecision {
  accept: boolean;
  reason_code: ReframeCode;
}

/**
 * The credit classes: the keys whose learning (α/β, goal-path increments, mints, the reached-command bank,
 * REUSE donor eligibility) a corpus case guards.
 */
export const CREDIT_CLASSES = [
  "floor:zero-tool",
  "floor:citation-only",
  "walk:reframed-target",
  "walk:prose-sink-for-change",
  "any:write-claim-zero-tool",
  "shortcut:borrowed-floor",
  "template:repeat-write-refusal",
] as const;
export type CreditClass = (typeof CREDIT_CLASSES)[number];

const has = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === "string" && (set as readonly string[]).includes(v);
export const isHollowClass = (v: unknown): v is HollowClass => has(HOLLOW_CLASSES, v);
export const isReasonCode = (v: unknown): v is ReasonCode => has(REASON_CODES, v);
export const isShortcutCode = (v: unknown): v is ShortcutCode => has(SHORTCUT_CODES, v);
export const isReframeCode = (v: unknown): v is ReframeCode => has(REFRAME_CODES, v);
export const isCreditClass = (v: unknown): v is CreditClass => has(CREDIT_CLASSES, v);
