/**
 * Builders of judge-input records (src/judge/records.ts) from what each judge site already has in scope.
 * Pure: they copy and normalise, they never fetch. Every field a site does not know gets its documented
 * neutral value.
 */
import { JUDGE_INPUT_SCHEMA, neutralEvidence, type CompletionShapesInput, type CreditOnHollowInput, type FloorShortcutInput, type FloorVerdictInput, type JudgeEvidence, type ReachGateInput, type ReframeAcceptInput } from "./records";

/** The write record a judge site passes to the reach gate (the walk's applied-write ledger, the floor's
 *  successful write calls, the engine's produced shapes): never the digest's prose. */
export interface WriteArtifactEvidence {
  persistedWrites: readonly string[];
  targets?: readonly string[];
  landed?: boolean;
  postReachSink?: boolean;
  /** Which judge site this is (neutral: walk). */
  surface?: "walk" | "floor" | "recovery";
}

export function reachInput(a: {
  goal: string;
  writeEvidence: WriteArtifactEvidence;
  /** The target list the site resolved (writeEvidence.targets, else deliverables, else inferred). */
  targets: readonly string[];
  deliverables?: readonly string[] | null;
  inferredTargets?: readonly string[] | null;
  landed: boolean;
  producedShapes?: readonly string[];
  digest?: string | null;
}): ReachGateInput {
  return {
    schema: JUDGE_INPUT_SCHEMA,
    entry: "reachGate",
    goal: a.goal,
    original_targets: [...(a.inferredTargets ?? a.deliverables ?? a.targets)],
    deliverables: a.deliverables ? [...a.deliverables] : null,
    targets_seen_by_walk: [...a.targets],
    reframed_from: null,
    evidence: { ...neutralEvidence(), persisted_writes: [...a.writeEvidence.persistedWrites], landed: a.landed, post_reach_sink: a.writeEvidence.postReachSink === true, produced_shapes: [...(a.producedShapes ?? [])] },
    surface: a.writeEvidence.surface ?? "walk",
    digest_excerpt: a.digest ? a.digest.slice(0, 2000) : null,
  };
}

export function floorInput(a: {
  goal: string;
  targets: readonly string[];
  writes: readonly string[];
  answerText: string;
  verdictReason: string | null;
  toolsTotal: number;
  toolsOk: number;
  groundedReads: number;
}): FloorVerdictInput {
  const evidence: JudgeEvidence = { ...neutralEvidence(), persisted_writes: [...a.writes], tools_total: a.toolsTotal, tools_ok: a.toolsOk, grounded_reads: a.groundedReads };
  return {
    schema: JUDGE_INPUT_SCHEMA,
    entry: "floorVerdict",
    goal: a.goal,
    original_targets: [...a.targets],
    deliverables: null,
    targets_seen_by_walk: [...a.targets],
    reframed_from: null,
    evidence,
    surface: "floor",
    digest_excerpt: null,
    answer_text: a.answerText,
    verdict_reason: a.verdictReason,
    seeded_evidence: false,
  };
}

export function shortcutInput(a: { goal: string; activities: readonly string[]; borrowed: boolean; targets: readonly string[] }): FloorShortcutInput {
  return { schema: JUDGE_INPUT_SCHEMA, entry: "floorShortcut", goal: a.goal, activities: [...a.activities], borrowed: a.borrowed, targets: [...a.targets] };
}

export function reframeInput(a: {
  goal: string;
  originalTargets: readonly string[];
  alternatives: readonly unknown[];
  altReached: boolean;
  substantive: readonly string[];
  onlyRawInput: boolean;
  skippedPlannedRetrieval: boolean;
  origWantedDerived: boolean;
}): ReframeAcceptInput {
  return {
    schema: JUDGE_INPUT_SCHEMA,
    entry: "reframeAccept",
    goal: a.goal,
    original_targets: [...a.originalTargets],
    alternatives: a.alternatives.filter((x): x is unknown[] => Array.isArray(x)).map((x) => x.map((sh) => String(sh))),
    alt_walk: { reached: a.altReached, substantive_shapes: [...a.substantive], only_raw_input: a.onlyRawInput, skipped_planned_retrieval: a.skippedPlannedRetrieval },
    orig_wanted_derived: a.origWantedDerived,
  };
}

export function creditInput(a: { templateClass: string; deterministic: boolean; noOracle: boolean; consumedInChain: number; lastPickProducedJudgedArtifact: boolean }): CreditOnHollowInput {
  return {
    schema: JUDGE_INPUT_SCHEMA,
    entry: "creditOnHollow",
    template_id_class: a.templateClass,
    verdict: { deterministic: a.deterministic, hollow_class: null, no_oracle: a.noOracle },
    consumed_in_chain: a.consumedInChain,
    edit_effect_reach: false,
    last_pick_produced_judged_artifact: a.lastPickProducedJudgedArtifact,
    history: [],
  };
}

export function completionInput(judgeNamed: readonly string[] | undefined, produced: readonly string[]): CompletionShapesInput {
  return { schema: JUDGE_INPUT_SCHEMA, entry: "completionShapes", judge_named: [...(judgeNamed ?? [])], produced: [...produced] };
}
