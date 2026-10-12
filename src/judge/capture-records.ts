// JUDGE AND ROUTING CAPTURE RECORDS (closed core, src/judge/): the record types src/judge/capture.ts writes.
// Field names follow DESIGN §4.1 (judge_input) and the routing addendum §A3 (routing_input) exactly; every
// field beyond those is additive. schema 1.

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
  /** How many times this entry was decided on this dispatch; the record kept is the last one. */
  calls: number;
  capped?: boolean;
}

export interface RoutingResolution {
  terms: string[];
  candidates: Array<{ via: "term" | "symbol" | "proposal"; term: string; scope: string | null; hits: string[] | null; error: boolean }>;
  chosen_file: string | null;
  method: string;
  reads: Array<{ path: string; readable: boolean }>;
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
  /** Additive: the gap record the walk hydrated, the file it cites, and whether that file was put on the routing goal. */
  gap_hint: { gap_id: string; cited_file: string | null; applied: boolean } | null;
  trail: string[];
  capped?: boolean;
}

export interface JudgeCaptureMetadata {
  judge_input?: Partial<Record<JudgeEntry, JudgeInputRecord>>;
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
export interface ReachGateEvidence {
  persisted_writes: string[] | null;
  landed: boolean | null;
  produced_shapes: string[];
  post_reach_sink: boolean | null;
  tools_total: number | null;
  grounded_reads: number | null;
  output_impulses: number | null;
  consumed_in_chain: number | null;
}
export interface ReachGateInput {
  goal: string;
  original_targets: string[] | null;
  deliverables: string[] | null;
  targets_seen_by_walk: string[] | null;
  reframed_from: string[] | null;
  evidence: ReachGateEvidence;
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
export interface FloorVerdictInput extends ReachGateInput {
  answer_text: string;
  verdict_reason: string | null;
  seeded_evidence: boolean;
  /** Additive. */
  tools_ok: number;
  /** Additive. */
  authored_answer: boolean;
}
export interface FloorShortcutInput { goal: string; activities: string[]; borrowed: boolean; targets: string[] }
export interface ReframeAcceptInput {
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
export interface CreditOnHollowInput {
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
}
