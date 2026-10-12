/**
 * The credit classes of a judge input (closed). The live core notes these for every verdict it delivers,
 * and the corpus requires each case's declared credit_class to be among them, so the class a red case
 * holds is the class live verdicts of that kind carry.
 */
import { claimsWriteSucceeded } from "./floor-clamps";
import { isMutationShape, PROSE_SINK_SHAPES } from "./shapes";
import type { CreditClass } from "./classes";
import type { JudgeInput } from "./records";

/** The credit classes a judge input belongs to. The live core and the corpus use THIS function. */
export function creditClassesOf(input: JudgeInput, upstreamReason?: string | null): CreditClass[] {
  const out = new Set<CreditClass>();
  switch (input.entry) {
    case "floorVerdict": {
      const ev = input.evidence;
      if (ev.tools_total === 0 && ev.grounded_reads === 0) out.add("floor:zero-tool");
      if (/^deterministic:code-investigation-cited\b/.test(upstreamReason ?? input.verdict_reason ?? "")) out.add("floor:citation-only");
      if (ev.tools_total === 0 && (claimsWriteSucceeded(input.answer_text) || claimsWriteSucceeded(upstreamReason ?? input.verdict_reason))) out.add("any:write-claim-zero-tool");
      if (out.size === 0) out.add("floor:tooled");
      break;
    }
    case "reachGate": {
      if (input.reframed_from) out.add("walk:reframed-target");
      const w = input.evidence.persisted_writes;
      if (w.some((s) => PROSE_SINK_SHAPES.has(s))) out.add("walk:prose-sink-for-change");
      if (input.targets_seen_by_walk.some(isMutationShape) || (input.reframed_from ?? []).some(isMutationShape)) out.add("walk:mutation-target");
      if (out.size === 0) out.add("walk:read-target");
      break;
    }
    case "floorShortcut": out.add(input.borrowed ? "shortcut:borrowed-floor" : "shortcut:own-floor"); break;
    case "reframeAccept": out.add("walk:reframed-target"); break;
    case "completionShapes": out.add("floor:completion-shapes"); break;
    case "creditOnHollow": out.add(input.history.some((h) => h.refusal) ? "template:repeat-write-refusal" : "template:hollow-charge"); break;
  }
  return [...out];
}


// ── the classes of each goal's live verdicts (closed module state, bounded) ───────────────────────────

const NOTED_MAX = 512;
const noted = new Map<string, Set<CreditClass>>();
const goalKey = (goal: string): string => goal.trim().slice(0, 2000);

/** Record the credit classes of a verdict the core just delivered for `goal`. */
export function noteClasses(goal: string, classes: readonly CreditClass[]): void {
  if (!goal || classes.length === 0) return;
  const k = goalKey(goal);
  const s = noted.get(k) ?? new Set<CreditClass>();
  for (const c of classes) s.add(c);
  noted.delete(k);
  noted.set(k, s);
  while (noted.size > NOTED_MAX) noted.delete(noted.keys().next().value as string);
}

/** The credit classes the core has noted for `goal`'s verdicts in this process. */
export function classesForGoal(goal: string | undefined | null): CreditClass[] {
  return goal ? [...(noted.get(goalKey(goal)) ?? [])] : [];
}
