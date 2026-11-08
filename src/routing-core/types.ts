// THE ROUTING SCHEMA (closed). The input and output types of the routing rules (src/routing-rules/), owned by the
// closed core so an open rule cannot widen what it is given or what it may answer. The core's clamp (entries.ts)
// enforces the output types at run time; these declarations are their compile-time half.

/**
 * A LOCALIZATION RECORD (shape `localizationRecord`): which file a need is about, and the evidence that it is the site
 * (what was read, and why it shows the site). Persisted on the gap record (gap.localization) and on the trace; the
 * routing core and the compose admission read it. Schema: test/routing-corpus/localization-record.schema.json. The
 * core passes a record to the rules only when it is valid (validLocalizationRecord), so a rule never sees a malformed one.
 */
export type LocalizationRecord = {
  gap_id?: string;
  dispatch_id?: string;
  file: string;
  evidence: ReadonlyArray<{ read: string; why: string }>;
  method: string;
  created_at: string;
};
export type Localization = LocalizationRecord;

export type DoorInput = {
  /** The goal as dispatched, before any restatement. */
  goal: string;
  /** The resolver's restated goal, or null when it left the goal unrestated. */
  restated_goal: string | null;
  /** The file the resolver restated onto (the lead path of restated_goal), or null. */
  chosen_file: string | null;
  /** A localization record for this goal, when one exists. */
  localization: Localization | null;
};

export type DoorDecision = {
  /** The goal to dispatch: exactly `goal` or exactly `restated_goal`. */
  goal: string;
  /** The file the dispatched goal targets: `chosen_file` when restated, else null. */
  target: string | null;
  /** True when the goal must be localized (a file + evidence recorded) before it may be routed to a file edit. */
  needs_localization: boolean;
};

/**
 * Recorded answers to every read the pathless resolution makes (DESIGN §4.3 ports). Keys:
 *   search:        `${scope ?? "*"}|${preferCallSites ? 1 : 0}|${term}`  -> repo-relative files
 *   symbol_search: `${scope ?? "*"}|${word}`                             -> repo-relative files
 *   read_file:     path -> text (null = unreadable)
 * A read the record does not answer throws UnrecordedPort: a rule that starts reading something new is red, not
 * silently defaulted.
 */
export type RoutingPorts = {
  search: Record<string, readonly string[]>;
  symbol_search: Record<string, readonly string[]>;
  read_file: Record<string, string | null>;
};

/** Recorded model output the resolution consumed: the symptom->identifier proposal. Null when it was never asked. */
export type RoutingLlm = { propose_symbols: readonly string[] | null };
