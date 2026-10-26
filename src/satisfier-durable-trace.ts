/**
 * A SATISFIER-REACHED WALK'S DURABLE TRACE MUST BE AUDITABLE, OUT OF index.ts SO IT CAN BE TESTED.
 *
 * Finding agf_bgj5catiey2l. The floor path already persists what it concluded (final_text, capped)
 * and why (reach_reason). A satisfier-last walk persisted neither: each step's synthetic trace
 * carried only its output shape, the durable trace copied the last step plus a reach tag, and the
 * whole flush + persist sat inside the verify try, so a throw there dropped every unflushed step
 * and the durable row with it. The reached content went to the pool only.
 *
 * Pieces here (index.ts keeps the walk, the sink and the deadline):
 *   - `satisfierStepAudit`: per step, the shapes its resolve BOUND and a digest of what it returned.
 *   - `satisfierReachMetadata`: answer_body (the floor's final_text cap) or a pointer, reach_reason on
 *     every verdict, and the per-step resolver / bound inputs / digests.
 *   - `thrownVerifyDurableTrace`: the durable trace the walk's FINALLY persists when the verify threw
 *     before the durable persist ran. A throw is not a verdict: an unreached walk is persisted
 *     beta-withheld, so the arm is neither credited nor blamed for our own error.
 *   - `withBetaWithheld`: the withheld-β tags (moved from index.ts, which re-exports it).
 */
import { createHash } from "node:crypto";
import type { ExecutionTrace } from "@avigopal/ias-executor-ts";

/** The floor's final_text cap (index.ts universal-tool-fallback), so one reader renders both tiers. */
export const ANSWER_TEXT_CAP = 4000;
/** Steps kept on the durable trace, bounded like the failed-walk trace's step list. */
export const DURABLE_STEP_CAP = 40;

/** Cap a text the floor's way: the truncation is stated, never silent. */
export function capAnswerText(text: string, cap: number = ANSWER_TEXT_CAP): string {
  return text.length > cap ? `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]` : text;
}

export interface StepContentDigest { sha256_16: string; len: number }

/** A digest of a step's returned content: enough to tell two answers apart without storing either. */
export function stepContentDigest(content: unknown): StepContentDigest {
  let s: string;
  if (typeof content === "string") s = content;
  else { try { s = JSON.stringify(content) ?? String(content); } catch { s = String(content); } }
  return { sha256_16: createHash("sha256").update(s).digest("hex").slice(0, 16), len: s.length };
}

/** Per-step audit fields for a satisfier step's own trace metadata. */
export function satisfierStepAudit(boundInputs: Iterable<string>, content: unknown): { bound_inputs: string[]; content_digest: StepContentDigest } {
  return { bound_inputs: [...new Set(boundInputs)].sort(), content_digest: stepContentDigest(content) };
}

export interface DurableStep {
  id: string;
  resolver: string | null;
  shape: string | null;
  bound_inputs: string[];
  content_digest: StepContentDigest | null;
  output_impulse_ids: string[];
}

/** The walk's satisfier steps as the durable trace lists them (the last DURABLE_STEP_CAP). */
export function durableSteps(steps: readonly ExecutionTrace[]): DurableStep[] {
  return steps.slice(-DURABLE_STEP_CAP).map((t) => {
    const m = (t.metadata ?? {}) as { shape?: unknown; bound_inputs?: unknown; content_digest?: unknown };
    return {
      id: t.id,
      resolver: t.tasks?.[0]?.resolverId ?? null,
      shape: typeof m.shape === "string" ? m.shape : null,
      bound_inputs: Array.isArray(m.bound_inputs) ? m.bound_inputs.map(String) : [],
      content_digest: (m.content_digest as StepContentDigest | undefined) ?? null,
      output_impulse_ids: [...(t.outputImpulseIds ?? [])],
    };
  });
}

export interface SatisfierReachFacts {
  reached: boolean;
  reachReason: string | null | undefined;
  answerBody: string | null | undefined;
  /** The impulse ids that hold the answer, recorded when no answer body was rendered. */
  answerPointer?: readonly string[];
  steps: readonly ExecutionTrace[];
  verifyError?: string | null;
}

/** The audit metadata a satisfier-last walk's durable trace carries, on EVERY verdict. */
export function satisfierReachMetadata(f: SatisfierReachFacts): Record<string, unknown> {
  const body = typeof f.answerBody === "string" && f.answerBody.trim().length > 0 ? f.answerBody : null;
  return {
    reach_reason: f.reachReason ?? (f.verifyError ? `walk goal-reach verify error: ${f.verifyError}` : f.reached ? "reached (the verifier gave no reason)" : "not reached (no reason recorded)"),
    answer_body: body === null ? null : capAnswerText(body),
    answer_body_len: body === null ? 0 : body.length,
    ...(body === null && (f.answerPointer?.length ?? 0) > 0 ? { answer_pointer: [...(f.answerPointer ?? [])] } : {}),
    steps: durableSteps(f.steps),
    ...(f.verifyError ? { verify_error: f.verifyError.slice(0, 500) } : {}),
  };
}

/** Only a satisfier-last walk takes the durable path: the engine already persisted a template run. */
export function isSatisfierOnlyTrace(t: ExecutionTrace | null | undefined): boolean {
  return (t?.metadata as { satisfier?: boolean } | undefined)?.satisfier === true;
}

/**
 * A WITHHELD β RIDES ON THE PERSISTED TRACE. The trace sink forwards only tags and metadata, so the walk's
 * withhold decision travels as tags activity-api's insert path reads (beta_withheld:true, beta_withheld_reason:<r>):
 * it then applies no α/β to the arm and marks the row reach_withheld:true, as POST /reach does for beta_withheld.
 */
export function withBetaWithheld(tags: readonly string[] | undefined, reason: string | null | undefined): string[] {
  const kept = (tags ?? []).filter((t) => t !== "beta_withheld:true" && !t.startsWith("beta_withheld_reason:"));
  return [...kept, "beta_withheld:true", ...(reason ? [`beta_withheld_reason:${reason}`] : [])];
}

/**
 * The durable trace for a satisfier-last walk whose verify THREW before its durable persist ran; null for a
 * template run (the engine persisted it). A reach already decided stands (the walk returns it); otherwise the
 * row is failed and beta-withheld "verify-error", never reached:false, which would blame the arm for our throw.
 */
export function thrownVerifyDurableTrace(lastTrace: ExecutionTrace | null | undefined, f: SatisfierReachFacts & { verifyError: string }): ExecutionTrace | null {
  if (!lastTrace || !isSatisfierOnlyTrace(lastTrace)) return null;
  const kept = (lastTrace.tags ?? []).filter((t) => !/^reached:/.test(t));
  return {
    ...lastTrace,
    status: f.reached ? "completed" : "failed",
    reason: f.reachReason ?? `walk goal-reach verify error: ${f.verifyError}`,
    tags: f.reached ? [...kept, "reached:true"] : withBetaWithheld(kept, "verify-error"),
    metadata: { ...(lastTrace.metadata ?? {}), ...satisfierReachMetadata(f) },
  };
}
