// THE ROUTING SCHEMA (closed). The input and output types of the routing rules (src/routing-rules/), owned by the
// closed core so an open rule cannot widen what it is given or what it may answer. The core's clamp (entries.ts)
// enforces the output types at run time; these declarations are their compile-time half.

/** Where a goal goes after the hand-off. A new value is a closed (core) change. */
export type RouteName = "feature_compose" | "walk";

/** A file + the evidence that it is the site (what was read and why). Null until a localization record exists. */
export type Localization = { file: string; evidence: readonly string[] };

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

export type HandoffInput = {
  /** The goal the early edit-intent check reads: the dispatched goal plus any gap-record hydration suffix. */
  goal_for_routing: string;
  /** Whether the early edit-intent route is enabled on this node (read by the core at use time). */
  route_enabled: boolean;
};

export type HandoffDecision = {
  route: RouteName;
  /** The repos/<vessel>/<path>.<ext> file the compose edits; null when route is "walk". */
  target: string | null;
};

/** A gap record's hydration of the hand-off goal: the file the record cites and its summary. */
export type Hydration = { cited_file: string; summary: string };

/** The editIntent record: everything the composed route reads, and nothing it fetches (the ports carry the reads). */
export type EditIntentInput = {
  schema: 1;
  entry: "editIntent";
  /** The goal as dispatched, before any restatement. */
  goal: string;
  route_enabled: boolean;
  /** Gap-record hydration found for the dispatched goal, or null (no gap id, no record, or no cited file). */
  hydration: Hydration | null;
  localization: Localization | null;
};

/** The composed route, as the corpus pins it. */
export type RouteDecision = { route: RouteName; target: string | null; needs_localization: boolean };

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
