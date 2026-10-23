/**
 * CAPTURED -> REPLAY (closed): turn a judge-input record goal-host CAPTURED live (src/judge/capture.ts, the dispatch
 * record's metadata.judge_input.<entry>) into the replay record the judge entries read (src/judge/records.ts), so a
 * live decision can be replayed by the corpus runner (the held-out guard, the live-shadow check).
 *
 * Every nullable captured field is mapped EXPLICITLY. Where the production site's own code gives an unset value a
 * meaning (it reads `postReachSink === true`, so unset IS false), that meaning is applied and named here. Where the
 * replay entry NEEDS a value the record does not carry (null, absent, or cut by the capture's size cap), the record
 * is UNREPLAYABLE and the missing field(s) are named. Nothing is ever defaulted to make a record "answer".
 */
import type {
  CapturedCreditOnHollowInput, CapturedFloorShortcutInput, CapturedFloorVerdictInput, CapturedReachGateInput, CapturedReframeAcceptInput,
  CreditOnHollowInput, FloorShortcutInput, FloorVerdictInput, JudgeInputRecord, ReachGateInput, RecordedJudgeVerdict, RecordedLlmJudge, ReframeAcceptInput,
} from "./records";
import { JUDGE_INPUT_SCHEMA } from "./records";

/** The capture's truncation marker (src/judge/capture.ts CAPTURE_TRUNCATION_MARKER): a cut value is not the input. */
export const TRUNCATION_MARKER = "[judge-capture: truncated";
/** The gate's own hollow reason prefix: when the delivered verdict IS the gate's hollow, nothing downstream ran. */
const GATE_HOLLOW_PREFIX = "deterministic:write-goal-no-artifact";

export type ReplayEntry = "reachGate" | "floorVerdict" | "floorShortcut" | "reframeAccept" | "creditOnHollow";

/** A replayable record: the entry's replay input plus the upstream verdict the replay composes with. */
export interface Replayable {
  ok: true;
  /** Set when the recorded verdict WAS the gate's own hollow and no downstream judge was consulted: the record
   *  answers only if the candidate's gate also hollows; if the candidate's gate passes, it is unreplayable. */
  upstream_unknown: string | null;
  entry: ReplayEntry;
  input: ReachGateInput | FloorVerdictInput | FloorShortcutInput | ReframeAcceptInput | CreditOnHollowInput;
  /** The verdict the layers after the open rule delivered (the recorded upstream), or null when they gave none. */
  llm: { judge: RecordedJudgeVerdict } | null;
}
export interface Unreplayable { ok: false; entry: string | null; unreplayable: string[] }

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const cut = (v: unknown): boolean => (typeof v === "string" && v.includes(TRUNCATION_MARKER)) || (Array.isArray(v) && v.some(cut));

/** Collects what a replay needs and names what is missing. */
class Need {
  missing: string[] = [];
  str(path: string, v: unknown): string { if (typeof v !== "string" || cut(v)) { this.missing.push(path); return ""; } return v; }
  bool(path: string, v: unknown): boolean { if (typeof v !== "boolean") { this.missing.push(path); return false; } return v; }
  num(path: string, v: unknown): number { if (typeof v !== "number" || !Number.isFinite(v)) { this.missing.push(path); return 0; } return v; }
  arr(path: string, v: unknown): string[] { if (!isStrArr(v) || cut(v)) { this.missing.push(path); return []; } return [...v]; }
}

/** The upstream verdict for a gate-type entry: the delivered verdict, unless the delivered verdict WAS the gate's
 *  own hollow, in which case the downstream layers never ran and only a consulted LLM judge can stand in. */
function upstreamFor(need: Need, path: string, delivered: unknown, llm: RecordedLlmJudge | null | undefined, unknown: { why: string | null }): { judge: RecordedJudgeVerdict } | null {
  if (delivered === null) return null; // the site recorded "no verdict": a real value, not a missing one
  if (!delivered || typeof delivered !== "object") { need.missing.push(path); return null; }
  const d = delivered as { reached?: unknown; reason?: unknown; abstain?: unknown };
  const reason = typeof d.reason === "string" ? d.reason : "";
  if (reason.startsWith(GATE_HOLLOW_PREFIX)) {
    if (llm?.consulted === true && llm.judge) return { judge: { reached: llm.judge.reached === true, reason: llm.judge.reason ?? "", abstain: false } };
    unknown.why = "llm.judge (the recorded gate hollowed, so the downstream judge was never consulted, and this candidate's gate passes)";
    return null;
  }
  if (typeof d.reached !== "boolean") { need.missing.push(`${path}.reached`); return null; }
  return { judge: { reached: d.reached, reason, abstain: d.abstain === true || (typeof d.abstain === "object" && d.abstain !== null) } };
}

function evidenceOf(need: Need, c: CapturedReachGateInput, floor: boolean) {
  const e = c.evidence ?? ({} as CapturedReachGateInput["evidence"]);
  const produced = need.arr("input.evidence.produced_shapes", e.produced_shapes);
  const persisted = need.arr("input.evidence.persisted_writes (null: the site passed no write record, so the gate did not run)", e.persisted_writes);
  // landed: the gate's EFFECTIVE value as captured (landedEdit || writeEvidence.landed, the same landedEditOf the gate
  // calls). evidence.landed alone is the caller's flag and is NOT what the gate was handed. A record without
  // landed_effective (null, or captured before the field existed) is unreplayable: counted, never scored.
  let landed = false;
  if (typeof e.landed_effective === "boolean") landed = e.landed_effective;
  else need.missing.push(`input.evidence.landed_effective (${e.landed_effective === null ? "null" : "absent: captured before the field existed"})`);
  return {
    persisted_writes: persisted,
    landed,
    produced_shapes: produced,
    // the site reads `postReachSink === true`: unset IS false
    post_reach_sink: e.post_reach_sink === true,
    // read by the floor decision only
    tools_total: floor ? need.num("input.evidence.tools_total", e.tools_total) : (typeof e.tools_total === "number" ? e.tools_total : 0),
    tools_ok: 0,
    grounded_reads: floor ? need.num("input.evidence.grounded_reads", e.grounded_reads) : (typeof e.grounded_reads === "number" ? e.grounded_reads : 0),
    output_impulses: typeof e.output_impulses === "number" ? e.output_impulses : 0, // not read by any rule
    consumed_in_chain: typeof e.consumed_in_chain === "number" ? e.consumed_in_chain : 0, // not read by the reach rules
  };
}

/** normActivityId (index.ts): the shortcut site normalises activity ids before the rule sees them. */
const normActivityId = (s: string): string => s.replace(/^activity:/, "").replace(/[⟨⟩]/g, "").trim();

/**
 * Adapt one captured judge-input record. `rec` is metadata.judge_input.<entry> (a JudgeInputRecord); `delivered` is
 * the verdict production delivered for it (the held-out row's field), used only when the record carries no verdict.
 */
export function capturedToReplay(rec: unknown, entryHint?: string | null, delivered?: unknown): Replayable | Unreplayable {
  const r = (rec && typeof rec === "object" ? rec : null) as JudgeInputRecord | null;
  const entry = (typeof entryHint === "string" && entryHint) || (r && typeof r.entry === "string" ? r.entry : null);
  if (!r) return { ok: false, entry, unreplayable: ["input (no captured record)"] };
  if (r.schema !== JUDGE_INPUT_SCHEMA) return { ok: false, entry, unreplayable: [`schema (captured schema ${JSON.stringify(r.schema)} has no migration)`] };
  if (r.entry !== entry) return { ok: false, entry, unreplayable: [`entry (the record is ${JSON.stringify(r.entry)}, the held-out row says ${JSON.stringify(entry)})`] };
  const need = new Need();
  const c = (r.input ?? {}) as Record<string, unknown>;
  // the captured verdict carries the reasons and the floor's gate verdict; the held-out row's `delivered` is used
  // only when the record carries none
  const verdict = r.verdict !== undefined ? r.verdict : delivered;
  let out: Replayable | null = null;
  const unknown: { why: string | null } = { why: null };
  switch (entry) {
    case "reachGate": {
      const ci = c as unknown as CapturedReachGateInput;
      const goal = need.str("input.goal", ci.goal);
      // the gate classifies on writeEvidence.targets ?? deliverables ?? the inferred targets (original_targets)
      const seen = ci.targets_seen_by_walk ?? ci.original_targets;
      const targets = need.arr("input.targets_seen_by_walk (and no original_targets to fall back to, as the gate does)", seen);
      const evidence = evidenceOf(need, ci, false);
      const input: ReachGateInput = {
        schema: JUDGE_INPUT_SCHEMA, entry: "reachGate", goal,
        original_targets: isStrArr(ci.original_targets) ? [...ci.original_targets] : targets,
        deliverables: isStrArr(ci.deliverables) ? [...ci.deliverables] : null,
        targets_seen_by_walk: targets,
        reframed_from: isStrArr(ci.reframed_from) ? [...ci.reframed_from] : null,
        evidence, surface: ci.surface === "walk" || ci.surface === "floor" || ci.surface === "recovery" ? ci.surface : "walk",
        digest_excerpt: typeof ci.digest_excerpt === "string" ? ci.digest_excerpt : null,
      };
      out = { ok: true, entry, input, llm: upstreamFor(need, "verdict", verdict, r.llm, unknown), upstream_unknown: null };
      break;
    }
    case "floorVerdict": {
      const ci = c as unknown as CapturedFloorVerdictInput;
      const goal = need.str("input.goal", ci.goal);
      const targets = need.arr("input.targets_seen_by_walk", ci.targets_seen_by_walk);
      const evidence = evidenceOf(need, ci, true);
      evidence.tools_ok = need.num("input.tools_ok", ci.tools_ok);
      const input: FloorVerdictInput = {
        schema: JUDGE_INPUT_SCHEMA, entry: "floorVerdict", goal,
        original_targets: isStrArr(ci.original_targets) ? [...ci.original_targets] : targets,
        deliverables: null, targets_seen_by_walk: targets, reframed_from: null, evidence, surface: "floor",
        digest_excerpt: typeof ci.digest_excerpt === "string" ? ci.digest_excerpt : null,
        answer_text: need.str("input.answer_text", ci.answer_text),
        verdict_reason: typeof ci.verdict_reason === "string" ? ci.verdict_reason : null,
        seeded_evidence: ci.seeded_evidence === true,
      };
      // the floor's upstream is the gate verdict it consumed (after the closed F-a clamp)
      const v = (verdict && typeof verdict === "object" ? (verdict as { gate_verdict?: unknown }).gate_verdict : undefined);
      if (v === undefined) need.missing.push("verdict.gate_verdict");
      out = { ok: true, entry, input, llm: v === undefined ? null : upstreamFor(need, "verdict.gate_verdict", v, r.llm, unknown), upstream_unknown: null };
      break;
    }
    case "floorShortcut": {
      const ci = c as unknown as CapturedFloorShortcutInput;
      const input: FloorShortcutInput = {
        schema: JUDGE_INPUT_SCHEMA, entry: "floorShortcut", goal: need.str("input.goal", ci.goal),
        activities: need.arr("input.activities", ci.activities).map(normActivityId),
        borrowed: need.bool("input.borrowed", ci.borrowed), targets: need.arr("input.targets", ci.targets),
      };
      out = { ok: true, entry, input, llm: null, upstream_unknown: null };
      break;
    }
    case "reframeAccept": {
      const ci = c as unknown as CapturedReframeAcceptInput;
      const aw = ci.alt_walk ?? ({} as CapturedReframeAcceptInput["alt_walk"]);
      const alts = Array.isArray(ci.alternatives) && ci.alternatives.every(isStrArr) && !cut(ci.alternatives) ? ci.alternatives.map((a) => [...a]) : (need.missing.push("input.alternatives"), []);
      const input: ReframeAcceptInput = {
        schema: JUDGE_INPUT_SCHEMA, entry: "reframeAccept", goal: need.str("input.goal", ci.goal),
        original_targets: need.arr("input.original_targets", ci.original_targets), alternatives: alts,
        alt_walk: {
          reached: need.bool("input.alt_walk.reached", aw.reached),
          substantive_shapes: need.arr("input.alt_walk.substantive_shapes", aw.substantive_shapes),
          only_raw_input: need.bool("input.alt_walk.only_raw_input", aw.only_raw_input),
          skipped_planned_retrieval: need.bool("input.alt_walk.skipped_planned_retrieval", aw.skipped_planned_retrieval),
        },
        orig_wanted_derived: need.bool("input.orig_wanted_derived", ci.orig_wanted_derived),
      };
      out = { ok: true, entry, input, llm: null, upstream_unknown: null };
      break;
    }
    case "creditOnHollow": {
      const ci = c as unknown as CapturedCreditOnHollowInput;
      const v = ci.verdict ?? ({} as CapturedCreditOnHollowInput["verdict"]);
      const input: CreditOnHollowInput = {
        schema: JUDGE_INPUT_SCHEMA, entry: "creditOnHollow",
        template_id_class: typeof ci.template_id_class === "string" ? ci.template_id_class : (need.missing.push("input.template_id_class"), ""),
        verdict: { deterministic: need.bool("input.verdict.deterministic", v.deterministic), hollow_class: typeof v.hollow_class === "string" ? v.hollow_class : null, no_oracle: need.bool("input.no_oracle", ci.no_oracle) },
        consumed_in_chain: need.num("input.consumed_in_chain", ci.consumed_in_chain),
        edit_effect_reach: ci.edit_effect_reach === true,
        last_pick_produced_judged_artifact: need.bool("input.last_pick_produced_judged_artifact", ci.last_pick_produced_judged_artifact),
        // history is carried but not read by the decision; captured null (the trace-store read is not made yet) is []
        history: Array.isArray(ci.history) ? ci.history.map((h) => ({ attempt: h.attempt, write_shape: h.write_shape, refusal: h.refusal })) : [],
        ...(typeof ci.declined === "string" && ci.declined ? { declined: ci.declined } : {}),
      };
      out = { ok: true, entry, input, llm: null, upstream_unknown: null };
      break;
    }
    default:
      return { ok: false, entry, unreplayable: [`entry (${JSON.stringify(entry)} is not a replayable judge entry)`] };
  }
  if (need.missing.length > 0) return { ok: false, entry, unreplayable: [...new Set(need.missing)] };
  out!.upstream_unknown = unknown.why;
  return out!;
}

// ── the held-out replay (the contract the pull-sync admission glue relies on) ───────────────────────────────────

/** One held-out record: a delivered live verdict and the captured input it was decided on. */
export interface HeldoutRecord {
  record_hash: string;
  family: string;
  entry: string;
  delivered: unknown;
  /** The captured record: metadata.judge_input.<entry> from goal-host's dispatch store. */
  input: unknown;
  ports?: unknown;
  llm?: unknown;
}
/** The candidate's verdict per record. An unreplayable record has reached:null AND names what it lacks. */
export type HeldoutResult = { record_hash: string; reached: boolean } | { record_hash: string; reached: null; unreplayable: string[] };

/**
 * Replay every held-out record through THIS tree's judge entries (in-process, hermetic: the corpus runner's own
 * replay with its determinism guards). Never throws; a record that cannot be replayed says why.
 */
export async function heldoutReplay(records: readonly unknown[]): Promise<HeldoutResult[]> {
  const { replayCase } = await import("./corpus-runner");
  const judge = await import("./entries");
  return records.map((raw, i) => {
    const rec = (raw && typeof raw === "object" ? raw : {}) as Partial<HeldoutRecord>;
    const record_hash = typeof rec.record_hash === "string" ? rec.record_hash : `#${i}`;
    if (rec.family !== "judge_input") return { record_hash, reached: null, unreplayable: [`family (${JSON.stringify(rec.family)} is not replayed by the judge corpus)`] };
    const inner = rec.input && typeof rec.input === "object" ? { ...(rec.input as object) } as Record<string, unknown> : rec.input;
    if (inner && typeof inner === "object") {
      if (rec.llm !== undefined) (inner as Record<string, unknown>)["llm"] = rec.llm; // the row's own llm/ports, when given, are authoritative
      if (rec.ports !== undefined) (inner as Record<string, unknown>)["ports"] = rec.ports;
    }
    const a = capturedToReplay(inner, typeof rec.entry === "string" ? rec.entry : null, rec.delivered);
    if (!a.ok) return { record_hash, reached: null, unreplayable: a.unreplayable };
    if (a.upstream_unknown) {
      // the recorded gate hollowed and nothing downstream ran: answerable only if THIS candidate's gate hollows too
      const g = judge.replaying(() => judge.reachGate({ ...(a.input as ReachGateInput), entry: "reachGate" }));
      if (g.hollow) return { record_hash, reached: false };
      return { record_hash, reached: null, unreplayable: [a.upstream_unknown] };
    }
    const c = { schema: 1, id: "0000-heldout", class: "heldout", entry: a.entry, credit_class: "", edit_site: "", provenance: { source: "heldout", recorded: "", note: "", fidelity: "recorded-input", trace_ref: null }, input: a.input, llm: a.llm, ports: {}, expect: {}, status_at_append: "green", control: false, licenses: null } as unknown as Parameters<typeof replayCase>[0];
    const r = replayCase(c);
    if (r.outcome !== "green" || !r.observed) return { record_hash, reached: null, unreplayable: [`replay (${r.outcome}: ${r.diffs.join("; ").slice(0, 200)})`] };
    const o = r.observed;
    // reach entries answer `reached`; the shortcut answers allowed/refused; the credit decision answers charged/withheld
    const reached = a.entry === "floorShortcut" ? o.shortcut === "allowed" : a.entry === "creditOnHollow" ? o.credit === "charged" : o.reached === true;
    return { record_hash, reached };
  });
}
