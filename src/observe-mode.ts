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
// Every trace goal-host persists for an observe dispatch carries the tag learning_mode:observe (observeTaggingSink),
// so activity-api's insert path records it without grading any posterior.

export type LearningMode = "observe" | "learn";

export type ObserveSideEffect =
  | "failure_memory" | "reached_command_bank" | "reached_command_evict" | "reach_gate_lesson" | "beta_penalty"
  | "oracle_label" | "gap_write" | "authoring_decision" | "vault_note" | "edit_intent_escalation" | "verifier_recipe"
  | "child_dispatch" | "alpha_credit" | "artifact_expectation" | "mode_blind_dispatch";

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

/**
 * Change resolvers that do not read learning_mode: dispatched from an observe walk they would run as learn (draft,
 * land, patch, cut over, or walk a nested goal as learn). development-vessel's gap_to_feature, apply_proposal_as_patch,
 * perf_canary_resolve and patch_with_tools; goal-host's own goal_execution (/resolve takes no learning mode).
 */
export const OBSERVE_MODE_BLIND_SHAPES: ReadonlySet<string> = new Set([
  "gap_to_feature", "apply_proposal_as_patch", "perf_canary_resolve", "patch_with_tools", "goal_execution",
]);
/** Change resolvers that read the pointer's learning_mode (feature_compose, and gap_compose, which runs it). */
export const OBSERVE_MODE_READING_SHAPES: ReadonlySet<string> = new Set(["feature_compose", "gap_compose"]);

const bareShape = (t: string): string => t.slice(t.lastIndexOf(":") + 1);

/**
 * The refusal for one walk egress that would hand an observe dispatch's work to a resolver that ignores the mode
 * (pure), or null. A mode-blind resolver is never dispatched; a mode-reading one only when the outgoing pointer itself
 * says learning_mode "observe" (a walk builds its pointer from pool values and model output, so it does not). Either
 * way the step is kept as a would-be op: the refusal names it, and nothing leaves goal-host.
 */
export function observeModeBlindRefusal(mode: unknown, shape: string, body: unknown): string | null {
  if (!isObserve(mode)) return null;
  const b = asRecord(body);
  const imp = asRecord(b?.["impulse"]);
  const ptr = asRecord(imp?.["pointer"]);
  const types = [shape, ptr?.["type"], imp?.["type"], b?.["type"]].filter((t): t is string => typeof t === "string").map(bareShape);
  const blind = types.find((t) => OBSERVE_MODE_BLIND_SHAPES.has(t));
  if (blind) return `observe: refused before egress — ${blind} does not read learning_mode, so an observe dispatch keeps it as a would-be op and never dispatches it`;
  const reading = types.find((t) => OBSERVE_MODE_READING_SHAPES.has(t));
  const p = ptr ?? imp ?? b;
  if (reading && p?.["learning_mode"] !== "observe") return `observe: refused before egress — this ${reading} pointer does not carry learning_mode "observe", so it would run as a landing compose; kept as a would-be op`;
  return null;
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

/** The tag an observe dispatch's traces carry: activity-api's insert path keys its no-grade skip on it. */
export const OBSERVE_TRACE_TAG = "learning_mode:observe";

/** A trace's tags for this dispatch's mode: an observe dispatch's gain the tag once; any other mode's are untouched. */
export function observeTraceTags(tags: readonly string[] | undefined, mode: unknown): string[] | undefined {
  if (!isObserve(mode)) return tags as string[] | undefined;
  const t = tags ?? [];
  return t.includes(OBSERVE_TRACE_TAG) ? [...t] : [...t, OBSERVE_TRACE_TAG];
}

/**
 * A trace sink whose every record carries the dispatch's observe tag (read at record time from the dispatch context).
 * One wrap at the one sink every goal-host-built trace goes through (the floor, the failed walk, satisfier steps,
 * applied writes, the walk composites), so no persist site can forget it. A learn trace is passed through as is.
 */
export function observeTaggingSink<T>(sink: { record(trace: T): Promise<void> }, readMode: () => unknown): { record(trace: T): Promise<void> } {
  return {
    record(trace: T): Promise<void> {
      const mode = readMode();
      if (!isObserve(mode)) return sink.record(trace);
      return sink.record({ ...trace, tags: observeTraceTags((trace as { tags?: string[] }).tags, mode) } as T);
    },
  };
}

/** What an observe dispatch's dry-run compose would have landed, as a structured record field (bounded: the record is
 *  persisted and polled, and an op can carry a whole file body). */
export type ObserveComposeRecord = { landed: false; verdict: string; would_be_ops: Array<Record<string, unknown>>; would_be_ops_total: number };
const WOULD_BE_OPS_MAX = 20;
const WOULD_BE_TEXT_MAX = 240;

/**
 * The record field for an observe dispatch's edit-intent route: the compose's verdict and the ops it would have
 * landed (feature_compose's would_be_ops), each kept as kind, path and line range, its text fields cut to an excerpt
 * with their full length. Spread onto the route's result beside observeComposeOutcome.
 */
export function observeComposeRecord(verdict: string, body: unknown): { observe: ObserveComposeRecord } {
  const raw = asRecord(body)?.["would_be_ops"];
  const ops = Array.isArray(raw) ? raw : [];
  const would_be_ops = ops.slice(0, WOULD_BE_OPS_MAX).map((op) => {
    const o = asRecord(op) ?? {};
    const kept: Record<string, unknown> = {};
    for (const k of ["kind", "path"]) if (typeof o[k] === "string") kept[k] = o[k];
    for (const k of ["start_line", "end_line"]) if (typeof o[k] === "number") kept[k] = o[k];
    for (const k of ["content", "old_string", "new_string"]) {
      const v = o[k];
      if (typeof v !== "string") continue;
      kept[k] = v.slice(0, WOULD_BE_TEXT_MAX);
      if (v.length > WOULD_BE_TEXT_MAX) kept[`${k}_chars`] = v.length;
    }
    return kept;
  });
  return { observe: { landed: false, verdict: verdict || "(none)", would_be_ops, would_be_ops_total: ops.length } };
}
