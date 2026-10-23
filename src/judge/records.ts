/**
 * THE JUDGE-INPUT RECORDS: exactly what each judge entry reads, and nothing it fetches.
 *
 * One record per entry, each carrying `schema` and `entry`. A record is replayable: the verdict corpus
 * (test/verdict-corpus/) stores records of this form with an expected verdict, and the closed runner feeds
 * them to the same entries production calls. The schema is ADDITIVE-ONLY: a new field gets a documented
 * neutral value for older records (the migration lives with the capture, never in the rules), and an
 * unknown schema is a refusal, never a default.
 *
 * Capture (writing these records onto the execution trace) imports these types; it does not redefine them.
 */

export const JUDGE_INPUT_SCHEMA = 1 as const;

/** What the run did, as the caller recorded it: never the digest's prose. */
export interface JudgeEvidence {
  /** Mutation shapes this execution actually wrote and the vessel accepted (or read back). */
  persisted_writes: string[];
  /** An edit-result shape WITH landing evidence (push_status:pushed / new_git_sha). */
  landed: boolean;
  produced_shapes: string[];
  /** The walk's post-reach bridge writes the note/concept for a durable-record goal after the verdict. */
  post_reach_sink: boolean;
  tools_total: number;
  /** Successful tool calls (the floor's `executedOk`); neutral value for a walk: tools_total. */
  tools_ok: number;
  grounded_reads: number;
  output_impulses: number;
  consumed_in_chain: number;
}

export interface ReachGateInput {
  schema: typeof JUDGE_INPUT_SCHEMA;
  entry: "reachGate";
  goal: string;
  /** The goal's inferred target shapes before any re-framing, unfiltered. */
  original_targets: string[];
  /** The dispatch's requested deliverables, when it named any. */
  deliverables: string[] | null;
  /** The target list the judge site resolved for this verdict (what today's gate classifies on). */
  targets_seen_by_walk: string[];
  /** When the walk was re-framed: the targets it was re-framed FROM (null when it was not). */
  reframed_from: string[] | null;
  evidence: JudgeEvidence;
  surface: "walk" | "floor" | "recovery";
  digest_excerpt: string | null;
}

export interface FloorVerdictInput extends Omit<ReachGateInput, "entry"> {
  entry: "floorVerdict";
  answer_text: string;
  verdict_reason: string | null;
  seeded_evidence: boolean;
}

export interface FloorShortcutInput {
  schema: typeof JUDGE_INPUT_SCHEMA;
  entry: "floorShortcut";
  goal: string;
  /** The recommended pathway's activity ids, normalised. */
  activities: string[];
  /** The pathway came from another goal (a shape-signature match). */
  borrowed: boolean;
  targets: string[];
}

export interface ReframeAcceptInput {
  schema: typeof JUDGE_INPUT_SCHEMA;
  entry: "reframeAccept";
  goal: string;
  original_targets: string[];
  alternatives: string[][];
  alt_walk: {
    reached: boolean;
    /** The re-framed walk's completion shapes minus punt and walk-mechanics shapes. */
    substantive_shapes: string[];
    only_raw_input: boolean;
    skipped_planned_retrieval: boolean;
  };
  orig_wanted_derived: boolean;
}

export interface CompletionShapesInput {
  schema: typeof JUDGE_INPUT_SCHEMA;
  entry: "completionShapes";
  judge_named: string[];
  produced: string[];
}

export interface CreditAttempt {
  attempt: number;
  write_shape: string | null;
  refusal: { error: string; field: string | null } | null;
}

export interface CreditOnHollowInput {
  schema: typeof JUDGE_INPUT_SCHEMA;
  entry: "creditOnHollow";
  /** A class key for the template (never an execution id). */
  template_id_class: string;
  verdict: { deterministic: boolean; hollow_class: string | null; no_oracle: boolean };
  consumed_in_chain: number;
  edit_effect_reach: boolean;
  last_pick_produced_judged_artifact: boolean;
  /** The K most recent attempts of the same template, newest last. Neutral value: []. */
  history: CreditAttempt[];
  /** The last pick's own answer declined, with this class (credit-decision.ts satisfierDeclineClass). Absent: it did not. */
  declined?: string | null;
}

export type JudgeInput = ReachGateInput | FloorVerdictInput | FloorShortcutInput | ReframeAcceptInput | CompletionShapesInput | CreditOnHollowInput;

/** A recorded upstream verdict the rules may use only where the deterministic layer abstains. */
export interface RecordedJudgeVerdict {
  reached: boolean;
  reason: string;
  abstain?: boolean;
}

export const neutralEvidence = (): JudgeEvidence => ({
  persisted_writes: [], landed: false, produced_shapes: [], post_reach_sink: false,
  tools_total: 0, tools_ok: 0, grounded_reads: 0, output_impulses: 0, consumed_in_chain: 0,
});

// ── THE CAPTURE FAMILY: what goal-host RECORDS live (src/judge/capture.ts writes these onto the dispatch) ──
// This file is the one canonical definition of both families. A captured record keeps every field the site
// had (nullable where a site does not know it, plus additive context); the replay records above are what the
// entries read. capture-records.ts re-exports these names for capture.ts's existing imports.

export type JudgeEntry = "reachGate" | "floorVerdict" | "floorShortcut" | "reframeAccept" | "creditOnHollow";
export type JudgeSurface = "walk" | "floor" | "recovery";
export type RoutingEntry = "editIntent";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** The recorded LLM-judge verdict a decision consumed. `consulted:false` means the judge was not asked. */
export interface RecordedLlmJudge { consulted: boolean; judge: { reached: boolean; reason: string | null; deterministic: boolean } | null }

/** The recorded ports. citation: one row per cited location the citation oracle re-read; write_readback: shape -> read back persisted. */
export interface RecordedPorts {
  citation: Array<{ path: string; line: number | null; read_at: string | null; contains: Record<string, boolean> | null; line_window_contains: Record<string, boolean> | null }>;
  write_readback: Record<string, boolean>;
}

export interface JudgeInputRecord {
  schema: number;
  entry: JudgeEntry;
  input: Record<string, Json>;
  llm: RecordedLlmJudge;
  ports: RecordedPorts;
  verdict: Json;
  /** How many times this entry was decided on this dispatch; judge_input.<entry> is the last one (earlier reachGate
   *  records are kept in judge_input_superseded). */
  calls: number;
  capped?: boolean;
}

export interface RoutingResolution {
  terms: string[];
  /** prefer_call_sites: the term search's preferCallSites flag (the search is keyed by it); null for symbol searches and proposals. */
  candidates: Array<{ via: "term" | "symbol" | "proposal"; term: string; scope: string | null; prefer_call_sites: boolean | null; hits: string[] | null; error: boolean }>;
  chosen_file: string | null;
  method: string;
  /** text: what the resolver read (null when unreadable), capped at CAPTURE_READ_CAP_CHARS; a cut read has capped:true and caps the record. */
  reads: Array<{ path: string; readable: boolean; text: string | null; capped?: boolean }>;
}

export interface RoutingInputRecord {
  schema: number;
  entry: RoutingEntry;
  goal: string;
  is_edit_intent: boolean;
  is_pathless_code_change: boolean;
  resolution: RoutingResolution;
  restated_goal: string | null;
  compose_gap_id: string | null;
  routed_to: "feature_compose" | "walk";
  edit_site: string | null;
  /** Additive: the early edit-intent route switch as the hand-off read it in-process; null until that check ran. */
  route_enabled: boolean | null;
  /** Additive: the localizationRecord the routing read for this need; null when there was none (always present as a key). */
  localization: unknown;
  /** Additive: the gap record the walk hydrated, the file it cites, whether that file was put on the routing goal, and
   *  (when applied) the record's summary the routing goal was built from. */
  gap_hint: { gap_id: string; cited_file: string | null; applied: boolean; summary: string | null } | null;
  trail: string[];
  capped?: boolean;
}

export interface JudgeCaptureMetadata {
  judge_input?: Partial<Record<JudgeEntry, JudgeInputRecord>>;
  /** Additive: every EARLIER reachGate record of this dispatch, oldest first (judge_input.reachGate is the latest), so a
   *  later gate call (the floor's, after a reaching walk) never erases an earlier one. Absent until a second reachGate
   *  capture. Bounded by CAPTURE_SUPERSEDED_CAP_BYTES: the oldest are dropped first, and counted in `dropped`. */
  judge_input_superseded?: { reachGate: JudgeInputRecord[]; dropped: number };
  routing_input?: RoutingInputRecord;
  /** Present when the dispatch's capture total was cut to its cap: what was cut and the size before the cut. */
  capture_truncated?: CaptureTruncation;
}

/** The per-dispatch total-cap marker. `truncated` names each cut field by path (e.g. judge_input.reachGate.input.digest_excerpt). */
export interface CaptureTruncation {
  cap_bytes: number;
  original_bytes: number;
  final_bytes: number;
  truncated: string[];
}

/** Anything a capture can be attached to: the dispatch record. */
export interface CaptureTarget { metadata?: JudgeCaptureMetadata }

// ── the documented inputs (DESIGN §4.1 names, snake_case as written; extra fields are additive) ──────────────
export interface CapturedReachGateEvidence {
  persisted_writes: string[] | null;
  landed: boolean | null;
  /** Additive: the gate's effective landed value, `landedEdit || writeEvidence.landed` (landed is the caller's flag alone). */
  landed_effective: boolean | null;
  produced_shapes: string[];
  post_reach_sink: boolean | null;
  tools_total: number | null;
  grounded_reads: number | null;
  output_impulses: number | null;
  consumed_in_chain: number | null;
}
export interface CapturedReachGateInput {
  goal: string;
  original_targets: string[] | null;
  deliverables: string[] | null;
  targets_seen_by_walk: string[] | null;
  reframed_from: string[] | null;
  evidence: CapturedReachGateEvidence;
  surface: JudgeSurface | null;
  digest_excerpt: string | null;
  /** Additive: what else the gate read (task summary, command evidence, the walk's step lines, the judge view). */
  gate_context: {
    task_summary: string | null;
    command_evidence: string | null;
    walk_gaps_filed: number | null;
    walk_step_lines: string[] | null;
    judge_view: Json;
  };
}
export interface CapturedFloorVerdictInput extends CapturedReachGateInput {
  answer_text: string;
  verdict_reason: string | null;
  seeded_evidence: boolean;
  /** Additive. */
  tools_ok: number;
  /** Additive. */
  authored_answer: boolean;
}
export interface CapturedFloorShortcutInput { goal: string; activities: string[]; borrowed: boolean; targets: string[] }
export interface CapturedReframeAcceptInput {
  goal: string;
  original_targets: string[];
  alternatives: string[][];
  /** Additive: the alternative the re-frame walked. */
  alt_targets: string[];
  alt_walk: { reached: boolean | null; substantive_shapes: string[]; only_raw_input: boolean; skipped_planned_retrieval: boolean; /** Additive. */ abstain: boolean; /** Additive. */ produced: string[] };
  orig_wanted_derived: boolean;
  /** Additive. */
  planned_retrieval: string[];
}
export interface CapturedCreditOnHollowInput {
  template_id_class: "satisfier" | "floor" | "template";
  verdict: { deterministic: boolean; hollow_class: string | null };
  consumed_in_chain: number;
  edit_effect_reach: boolean | null;
  last_pick_produced_judged_artifact: boolean;
  /** The template's K most recent attempts; null until the closed core reads them from the trace store. */
  history: Array<{ attempt: number; write_shape: string | null; refusal: { error: string; field: string | null } | null }> | null;
  /** Additive. */
  template_id: string;
  /** Additive. */
  no_oracle: boolean;
  /** Additive: the decline class, present only when the last pick's answer declined. */
  declined?: string;
}
