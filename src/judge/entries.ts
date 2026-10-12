/**
 * THE JUDGE ENTRIES (closed adapters). index.ts calls these at the reach gate, the floor, the floor-reuse
 * shortcut, the re-framing acceptance and the β block; the verdict corpus replays the same functions.
 *
 * Each entry takes a judge-input record (src/judge/records.ts), calls the open rule (src/judge-rules/)
 * where there is one, CLAMPS the rule's output to the closed schema (src/judge/classes.ts), and renders
 * the reason text from the rule's reason code, so an open rule can neither forge a reason nor return a
 * shape the core does not know. The rule is handed a deep-frozen copy of its input (callRule), so the clamp,
 * the renderer and everything after the call read the core's own input, which the rule cannot reach. A refused output, or rules that failed to load, fall back closed:
 * not reached, shortcut refused, re-frame rejected. Each fallback is counted and logged.
 *
 * The open rules are loaded by ONE dynamic import of exactly the named functions, once, when this module
 * loads. Nothing else imports src/judge-rules/.
 */
import type { CompletionShapesInput, CreditOnHollowInput, FloorShortcutInput, FloorVerdictInput, ReachGateInput, RecordedJudgeVerdict, ReframeAcceptInput } from "./records";
import { JUDGE_INPUT_SCHEMA } from "./records";
import { isHollowClass, isReasonCode, isReframeCode, isShortcutCode, type HollowClass, type ReasonCode, type ReframeCode, type RuleVerdict, type ShortcutCode } from "./classes";
import { floorCompletionShapes } from "./floor-clamps";
import { isMutationShape } from "./shapes";
import { creditOnHollow as creditDecision, type CreditOnHollowDecision } from "./credit-decision";
import { creditClassesOf, noteClasses } from "./credit-classes";

interface OpenRules {
  reachGate: (i: ReachGateInput) => unknown;
  floorDecide: (i: { upstream: RecordedJudgeVerdict | null; answer_text: string; evidence: ReachGateInput["evidence"] }) => unknown;
  floorShortcutAllowed: (i: FloorShortcutInput) => unknown;
  reframeAccept: (i: ReframeAcceptInput) => unknown;
}

let rules: OpenRules | null = null;
let rulesLoadError: string | null = null;
try {
  const { reachGate, floorDecide, floorShortcutAllowed, reframeAccept } = await import("../judge-rules/index");
  rules = { reachGate, floorDecide, floorShortcutAllowed, reframeAccept } as OpenRules;
} catch (e) {
  rulesLoadError = (e as Error)?.message ?? String(e);
  console.warn(`[judge] RULES UNLOADABLE — every judge entry falls back closed: ${rulesLoadError}`);
}

/** judge_rules.fell_back: how many entry calls fell back to the closed verdict, by entry. */
const fellBack = new Map<string, number>();
export function judgeRulesFellBack(): Record<string, number> { return Object.fromEntries(fellBack); }
function fallBack(entry: string, why: string): void {
  fellBack.set(entry, (fellBack.get(entry) ?? 0) + 1);
  console.warn(`[judge] judge_rules.fell_back entry=${entry} — ${why}; the closed fallback verdict is used`);
}

/** A replay (the verdict corpus) is not a live verdict: its classes are not noted for the credit hold. */
let replayDepth = 0;
export function replaying<T>(fn: () => T): T {
  replayDepth++;
  try { return fn(); } finally { replayDepth--; }
}
function note(goal: string, input: Parameters<typeof creditClassesOf>[0], upstreamReason?: string | null): void {
  if (replayDepth > 0) return;
  try { noteClasses(goal, creditClassesOf(input, upstreamReason)); } catch { /* noting never changes a verdict */ }
}

/** Test seam: run the entries against a different rules module (the corpus mutants and the clamp tests). */
export function withRules<T>(r: OpenRules | null, fn: () => T): T {
  const prev = rules;
  rules = r;
  try { return fn(); } finally { rules = prev; }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(o).sort();
  return k.length === keys.length && [...keys].sort().every((x, i) => x === k[i]);
};

/** The output-schema clamp for a verdict rule. Returns the refusal reason, or null when the output is valid. */
export function clampRuleVerdict(out: unknown, extraBooleans: readonly string[] = []): string | null {
  if (!isPlainObject(out)) return "output is not an object";
  if (!exactKeys(out, ["reached", "hollow_class", "reason_code", "deterministic", ...extraBooleans])) return `output keys [${Object.keys(out).join(",")}] are not exactly the rule schema`;
  if (typeof out.reached !== "boolean" || typeof out.deterministic !== "boolean") return "reached/deterministic is not a boolean";
  for (const b of extraBooleans) if (typeof out[b] !== "boolean") return `${b} is not a boolean`;
  if (out.hollow_class !== null && !isHollowClass(out.hollow_class)) return `unknown hollow class ${JSON.stringify(out.hollow_class)}`;
  if (!isReasonCode(out.reason_code)) return `unknown reason code ${JSON.stringify(out.reason_code)}`;
  if (out.reached === true && out.hollow_class !== null) return "a reached verdict carries a hollow class";
  return null;
}

function validRecord(i: { schema?: unknown; entry?: unknown }, entry: string): string | null {
  if (i?.schema !== JUDGE_INPUT_SCHEMA) return `unknown input schema ${JSON.stringify(i?.schema)}`;
  if (i?.entry !== entry) return `record entry ${JSON.stringify(i?.entry)} is not ${entry}`;
  return null;
}

/**
 * A deep-frozen structured copy of a rule's input. The rule never holds the core's own objects, so it cannot move what
 * the clamp, the reason renderer, the capture or the caller read after the call (each reads the core's input, which
 * the rule never saw).
 */
function frozenCopy<T>(v: T): T {
  const copy = structuredClone(v);
  const freeze = (o: unknown): void => {
    if (o === null || typeof o !== "object" || Object.isFrozen(o)) return;
    Object.freeze(o);
    for (const k of Object.keys(o as object)) freeze((o as Record<string, unknown>)[k]);
  };
  freeze(copy);
  return copy;
}

function callRule(entry: string, f: ((i: never) => unknown) | undefined, input: unknown): { out: unknown } | { error: string } {
  if (!f) return { error: rulesLoadError ? `rules unloadable: ${rulesLoadError}` : "rule missing" };
  let given: unknown;
  try { given = frozenCopy(input); } catch (e) { return { error: `input not copyable: ${(e as Error)?.message ?? String(e)}` }; }
  try { return { out: (f as (i: unknown) => unknown)(given) }; } catch (e) { return { error: `rule threw: ${(e as Error)?.message ?? String(e)}` }; }
}

// ── reachGate ─────────────────────────────────────────────────────────────────────────────────────────

export interface ReachGateResult {
  hollow: boolean;
  /** The verdict reason when hollow (rendered by the core). */
  reason: string | null;
  hollow_class: HollowClass | null;
  reason_code: ReasonCode | null;
  deterministic: boolean;
  fell_back: boolean;
}

function renderReachGateReason(code: ReasonCode, i: ReachGateInput): string {
  if (code === "write-goal-no-artifact:change" || code === "write-goal-no-artifact:write") {
    const targets = i.targets_seen_by_walk;
    const wrote = [...new Set(i.evidence.persisted_writes)];
    return `deterministic:write-goal-no-artifact — the goal asks for a ${code.endsWith(":change") ? "change" : "write"}${targets.length ? ` (targets [${targets.slice(0, 4).join(", ")}])` : ""}, and a change/write goal is reached only by a landed sha or a persisted write of its own target; ${wrote.length ? `the writes this run made ([${wrote.slice(0, 4).join(", ")}]) are prose or unrelated to it` : "this run persisted no write and landed nothing"}, so a plan or prose answer cannot reach it`;
  }
  if (code === "reframed-target") {
    return `deterministic:reframed-target — the walk was re-framed from [${(i.reframed_from ?? []).slice(0, 4).join(", ")}] and reached only a re-framed target; the goal's own target was never produced`;
  }
  return `deterministic:${code}`;
}

/** The write-goal gate within the reach verdict: a change/write goal is reached only by an artifact. */
export function reachGate(input: ReachGateInput): ReachGateResult {
  note(input?.goal, input);
  const bad = validRecord(input, "reachGate");
  const r = bad ? { error: bad } : callRule("reachGate", rules?.reachGate, input);
  const refused = "error" in r ? r.error : clampRuleVerdict(r.out);
  if (refused !== null) {
    fallBack("reachGate", refused);
    return { hollow: true, reason: `deterministic:judge-rules-refused — the reach rules could not be applied (${refused}); not reached, failing closed`, hollow_class: "judge-rules-refused", reason_code: null, deterministic: false, fell_back: true };
  }
  const v = (r as { out: RuleVerdict }).out;
  if (v.reached) return { hollow: false, reason: null, hollow_class: null, reason_code: v.reason_code, deterministic: v.deterministic, fell_back: false };
  return { hollow: true, reason: renderReachGateReason(v.reason_code, input), hollow_class: v.hollow_class, reason_code: v.reason_code, deterministic: v.deterministic, fell_back: false };
}

// ── floorVerdict ──────────────────────────────────────────────────────────────────────────────────────

export interface FloorVerdictResult {
  reached: boolean;
  fabricated_transcript: boolean;
  hollow_class: HollowClass | null;
  reason_code: ReasonCode | null;
  fell_back: boolean;
}

/**
 * The floor's own reach decision, given the upstream verdict (the reach gate, the closed oracles and the
 * LLM judge, after the closed F-a clamp). `upstream` is data: production passes the verdict it just got,
 * a replay passes the recorded one.
 */
export function floorVerdict(input: FloorVerdictInput, upstream: RecordedJudgeVerdict | null): FloorVerdictResult {
  note(input?.goal, input, upstream?.reason ?? null);
  const bad = validRecord(input, "floorVerdict");
  const r = bad ? { error: bad } : callRule("floorVerdict", rules?.floorDecide, { upstream, answer_text: input.answer_text, evidence: input.evidence });
  const refused = "error" in r ? r.error : clampRuleVerdict(r.out, ["fabricated_transcript"]);
  if (refused !== null) {
    fallBack("floorVerdict", refused);
    return { reached: false, fabricated_transcript: false, hollow_class: "judge-rules-refused", reason_code: null, fell_back: true };
  }
  const v = (r as { out: RuleVerdict & { fabricated_transcript: boolean } }).out;
  return { reached: v.reached, fabricated_transcript: v.fabricated_transcript, hollow_class: v.hollow_class, reason_code: v.reason_code, fell_back: false };
}

// ── floorShortcut ─────────────────────────────────────────────────────────────────────────────────────

export interface FloorShortcutResult { allowed: boolean; why: string; reason_code: ShortcutCode | null; fell_back: boolean }

function renderShortcutWhy(code: ShortcutCode, i: FloorShortcutInput): string {
  switch (code) {
    case "shortcut:not-the-floor": return "pathway is not exactly the floor";
    case "shortcut:edit-goal": return "edit goal";
    case "shortcut:durable-artifact-goal": return "durable-artifact goal";
    case "shortcut:mutation-targets": return `mutation target(s) [${i.targets.filter(isMutationShape).join(", ")}] are a durable artifact the floor cannot deliver`;
    case "shortcut:borrowed-for-change-goal": return "borrowed pathway (another goal's shape-signature match) for a change/write goal";
    case "shortcut:borrowed-for-read-goal": return "borrowed floor pathway for a read goal";
    case "shortcut:own-pathway": return "this goal's own floor pathway";
  }
}

/** REUSE-BEFORE-DERIVE: may a learned floor pathway stand in for the walk? */
export function floorShortcut(input: FloorShortcutInput): FloorShortcutResult {
  note(input?.goal, input);
  const bad = validRecord(input, "floorShortcut");
  const r = bad ? { error: bad } : callRule("floorShortcut", rules?.floorShortcutAllowed, input);
  let refused: string | null = "error" in r ? r.error : null;
  if (refused === null) {
    const o = (r as { out: unknown }).out;
    if (!isPlainObject(o) || !exactKeys(o, ["allowed", "reason_code"])) refused = "output keys are not exactly {allowed, reason_code}";
    else if (typeof o.allowed !== "boolean") refused = "allowed is not a boolean";
    else if (!isShortcutCode(o.reason_code)) refused = `unknown reason code ${JSON.stringify(o.reason_code)}`;
    else if (o.allowed !== (o.reason_code === "shortcut:own-pathway" || o.reason_code === "shortcut:borrowed-for-read-goal")) refused = "allowed disagrees with its reason code";
  }
  if (refused !== null) {
    fallBack("floorShortcut", refused);
    return { allowed: false, why: `judge rules refused (${refused})`, reason_code: null, fell_back: true };
  }
  const o = (r as { out: { allowed: boolean; reason_code: ShortcutCode } }).out;
  return { allowed: o.allowed, why: renderShortcutWhy(o.reason_code, input), reason_code: o.reason_code, fell_back: false };
}

// ── reframeAccept ─────────────────────────────────────────────────────────────────────────────────────

export interface ReframeAcceptResult { accept: boolean; reason_code: ReframeCode | null; fell_back: boolean }

/** Does the re-framed walk's reach stand in for the original goal? */
export function reframeAccept(input: ReframeAcceptInput): ReframeAcceptResult {
  note(input?.goal, input);
  const bad = validRecord(input, "reframeAccept");
  const r = bad ? { error: bad } : callRule("reframeAccept", rules?.reframeAccept, input);
  let refused: string | null = "error" in r ? r.error : null;
  if (refused === null) {
    const o = (r as { out: unknown }).out;
    if (!isPlainObject(o) || !exactKeys(o, ["accept", "reason_code"])) refused = "output keys are not exactly {accept, reason_code}";
    else if (typeof o.accept !== "boolean") refused = "accept is not a boolean";
    else if (!isReframeCode(o.reason_code)) refused = `unknown reason code ${JSON.stringify(o.reason_code)}`;
    else if (o.accept !== (o.reason_code === "reframe:accepted")) refused = "accept disagrees with its reason code";
  }
  if (refused !== null) {
    fallBack("reframeAccept", refused);
    return { accept: false, reason_code: null, fell_back: true };
  }
  const o = (r as { out: { accept: boolean; reason_code: ReframeCode } }).out;
  return { accept: o.accept, reason_code: o.reason_code, fell_back: false };
}

// ── completionShapes (closed floor clamp F-b) ─────────────────────────────────────────────────────────

export function completionShapes(input: CompletionShapesInput): string[] {
  return floorCompletionShapes(input.judge_named, input.produced);
}

// ── creditOnHollow (closed) ───────────────────────────────────────────────────────────────────────────

export function creditOnHollow(input: CreditOnHollowInput): CreditOnHollowDecision {
  return creditDecision(input);
}
