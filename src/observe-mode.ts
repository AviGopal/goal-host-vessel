// OBSERVE IS SIDE-EFFECT-FREE: a dispatch with learning_mode "observe" changes no learned or persistent state.
//
// Measured: an observe probe was routed by the early edit-intent route to feature_compose, which grounded, planned,
// drafted and ran the suite (only an admission refusal stopped a landing), and the same dispatch wrote the failure
// memory (REMEMBERED), a reached-command tombstone, and a reach-gate lesson into concept-db. learning_mode had
// governed the goal-path, mint and router writes only; every other write decided its own fate.
//
// The mode is the dispatch's own structured field (body.learning_mode), carried in the dispatch context, never read
// from the goal's wording. Each side effect a dispatch can cause asks observeSkips() first: under observe it records
// nothing and says so ONCE per (dispatch, side effect), as "[observe] skipped <side-effect> (dispatch observe)", and
// a per-effect counter (observeSkipCounters, on /health) counts every skip. A walk egress that would write the gap
// store is refused before any byte leaves (observeEgressRefusal, wired into walkEgressFetch), and a write target is
// dropped from the walk's target set in the write door's style (observeDropShapes).
//
// What observe still writes: the dispatch record and its trace (the measurement itself) and the reach patch, which
// carries `reached` onto the trace (activity-api grades posteriors on arrival; that grading is not decidable here).

export type LearningMode = "observe" | "learn";

export type ObserveSideEffect =
  | "failure_memory" | "reached_command_bank" | "reached_command_evict" | "reach_gate_lesson" | "beta_penalty"
  | "oracle_label" | "gap_write" | "authoring_decision" | "vault_note" | "edit_intent_escalation" | "verifier_recipe"
  | "child_dispatch";

export function isObserve(mode: unknown): boolean {
  return mode === "observe";
}

export function observeSkipLine(effect: ObserveSideEffect): string {
  return `[observe] skipped ${effect} (dispatch observe)`;
}

const counters = new Map<ObserveSideEffect, number>();
const announced = new Map<string, Set<ObserveSideEffect>>();
const ANNOUNCED_MAX = 512;
export function observeSkipCounters(): Record<string, number> { return Object.fromEntries(counters); }
export function resetObserveSkips(): void { counters.clear(); announced.clear(); }

/**
 * Whether this side effect is skipped (the dispatch is in observe mode). A skip is counted every time and recorded
 * once per (dispatchKey, effect); a learn (or absent) mode skips nothing and records nothing.
 */
export function observeSkips(mode: unknown, dispatchKey: string | undefined | null, effect: ObserveSideEffect, record: (line: string) => void = (l) => console.log(l)): boolean {
  if (!isObserve(mode)) return false;
  counters.set(effect, (counters.get(effect) ?? 0) + 1);
  const key = dispatchKey || "-";
  let seen = announced.get(key);
  if (!seen) {
    if (announced.size >= ANNOUNCED_MAX) { const first = announced.keys().next().value; if (first !== undefined) announced.delete(first); }
    seen = new Set();
    announced.set(key, seen);
  }
  if (!seen.has(effect)) { seen.add(effect); record(observeSkipLine(effect)); }
  return true;
}

/** The shapes an observe dispatch may not write: the gap store's write (bare or vessel-qualified). */
export function isObserveRefusedWrite(t: unknown): boolean {
  return typeof t === "string" && (t === "substrateGap_write" || t.endsWith(":substrateGap_write"));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The refusal for one walk egress under observe (pure), or null. Read the way walkEgressRefusal reads a body: the
 * site's shape, or any type the outgoing body carries (impulse.pointer, impulse, the bare body).
 */
export function observeEgressRefusal(mode: unknown, shape: string, body: unknown): string | null {
  if (!isObserve(mode)) return null;
  const b = asRecord(body);
  const imp = asRecord(b?.["impulse"]);
  const ptr = asRecord(imp?.["pointer"]);
  const types = [shape, ptr?.["type"], imp?.["type"], b?.["type"]];
  const hit = types.find((t) => isObserveRefusedWrite(t));
  return hit ? `observe: refused before egress — an observe dispatch writes no gap (${String(hit)})` : null;
}

/** The walk's target form: an observe dispatch drops a gap-write target, and the drop is recorded. */
export function observeDropShapes(shapes: readonly string[], mode: unknown, dispatchKey: string | undefined | null, record?: (line: string) => void): string[] {
  if (!isObserve(mode)) return [...shapes];
  const kept = shapes.filter((s) => !isObserveRefusedWrite(s));
  if (kept.length < shapes.length) observeSkips(mode, dispatchKey, "gap_write", record);
  return kept;
}

/** observeDropShapes on a walk's own target set, in place. */
export function observeDropFrom(target: Set<string>, mode: unknown, dispatchKey: string | undefined | null, record?: (line: string) => void): void {
  if (!isObserve(mode)) return;
  const kept = new Set(observeDropShapes([...target], mode, dispatchKey, record));
  for (const s of [...target]) if (!kept.has(s)) target.delete(s);
}

/**
 * The fields a feature_compose hand-off carries for this dispatch, spread AFTER the pointer's land:true. Observe asks
 * for a run that may draft and verify but never lands: learning_mode "observe" (feature_compose admits it exactly as
 * a landing compose and returns the would-be ops) and, independently of whether that feature_compose reads the mode
 * yet, land:false + skip_push:true, so no deployment order can turn an observe probe into a commit. feature_compose's
 * own dry_run is plan-only (no draft, no verify), so it is not what observe sends.
 */
export function observeComposeFields(mode: unknown): { learning_mode?: "observe"; land?: false; skip_push?: true } {
  return isObserve(mode) ? { learning_mode: "observe", land: false, skip_push: true } : {};
}

/** The reason an observe dispatch's edit-intent route ends with: the compose ran as a dry run, nothing landed. */
export function observeComposeReason(verdict: string, detail: string): string {
  return `observe: dry run, not landed — feature_compose verdict=${verdict || "(none)"}; ${detail}`.slice(0, 600);
}

/**
 * How an observe dispatch's edit-intent route ends: an ABSTAIN (§9.2), never a verdict. A dry run cannot reach (nothing
 * landed) and is not a failure of the goal either, so it is ungraded: /run-goal records reached:null, delivers no
 * reach verdict and remembers no failure, and the reason names the compose's own verdict.
 */
export function observeComposeOutcome(verdict: string, detail: string): { goalReachReason: string; reached: false; abstain: { kind: "observe-dry-run"; cuts: never[] } } {
  return { goalReachReason: observeComposeReason(verdict, detail), reached: false, abstain: { kind: "observe-dry-run", cuts: [] } };
}
