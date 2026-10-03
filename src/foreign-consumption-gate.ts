/**
 * Foreign-consumption gate: may a run that executed on the SHARED impulse store be graded
 * reached, credited, or extracted?
 *
 * ias-executor-ts records, per task, the provenance of every impulse the task consumed
 * (`consumedProvenance`) and exports `foreignConsumption(trace)`, which decides from the
 * trace's own id / composition chain / seeds whether each consumed impulse was the run's.
 * Before that engine fix, concurrent executions bound each other's impulses; a run fed
 * another run's data can complete and look reached while answering a different question,
 * and extracting it mints that mistake as a template.
 *
 * VERSION SKEW IS EXPECTED, AND NEVER SILENT. goal-host and ias-executor-ts roll out
 * separately (the library reaches each vessel as a rebuilt dist), so this module reads the
 * export through a namespace object instead of a named import: a named import of a missing
 * export fails at module link and the vessel would not start. When the export is absent the
 * gate cannot check anything, so it says so ONCE per process -- a distinct log line and a
 * substrateGap_write with a stable id (the gap store dedupes on it) -- and lets the run
 * proceed. That fail-open window ends when this node's ias-executor-ts exports
 * `foreignConsumption`.
 *
 * BOUNDED FAIL-OPEN. When the export IS present, the engine that ran the trace records
 * provenance on every task that consumed anything (same release). A task that consumed
 * impulses yet carries no `consumedProvenance` is then not "old data", it is unverifiable,
 * and in `strict` mode it blocks. Strict applies where the trace comes straight from this
 * process's engine (walk steps, runGoal attempts). It is NOT applied to the reach->mint
 * check, whose input is often a goal-host-synthesised trace (walk composites, satisfier
 * records) that never passed through the engine; every engine trace feeding a mint has
 * already been checked strictly at the walk/runGoal reach gate.
 *
 * Remaining fail-open, by design and stated: a node whose ias-executor-ts predates the
 * export (loud + gap, above), until consumedProvenance crosses the trace-sink wire on all
 * nodes and the durable store can be checked too (follow-on; ribosome-vessel's census gate
 * reads activity-api, which carries no provenance yet).
 */
import type { ExecutionTrace } from "@avigopal/ias-executor-ts";

type ForeignEntry = { taskId: string; impulseId: string; producerExecutionId: string | null };
type ForeignConsumptionFn = (
  trace: Pick<ExecutionTrace, "id" | "tasks" | "compositionChain" | "inputImpulseIds">,
) => { status: "clean" | "foreign" | "unknown"; foreign: ForeignEntry[] };

export const GATE_UNAVAILABLE_LOG =
  "[foreign-consumption] gate unavailable: ias-executor too old (no foreignConsumption export) — " +
  "reach/extraction proceed WITHOUT the cross-execution impulse check on this node until its " +
  "ias-executor-ts dist is rebuilt";

export const GATE_UNAVAILABLE_GAP = {
  id: "foreign-consumption-gate-unavailable",
  title: "foreign-consumption gate unavailable: ias-executor too old",
  category: "service_failure",
  source: "substrate_detected",
  status: "open",
  summary:
    "goal-host-vessel cannot check whether a run consumed another execution's impulse: the " +
    "@avigopal/ias-executor-ts dist it loaded has no foreignConsumption export. Reach verdicts " +
    "and template extraction are proceeding unchecked on this node. Rebuild and propagate the " +
    "ias-executor-ts dist to goal-host-vessel (shared-package fan-out), then restart it.",
} as const;

export interface ForeignConsumptionGateDeps {
  /** The ias-executor-ts module namespace (or any object that may carry the export). */
  lib: Record<string, unknown>;
  log: (line: string) => void;
  /** Files a substrate gap. Called at most once per gate instance. */
  writeGap: (gap: typeof GATE_UNAVAILABLE_GAP) => Promise<unknown> | void;
}

export interface ForeignConsumptionVerdict {
  block: boolean;
  status: "clean" | "foreign" | "unverified" | "unknown" | "unavailable";
  reason?: string;
}

type TraceLike = Pick<ExecutionTrace, "id" | "tasks" | "compositionChain" | "inputImpulseIds">;

export function makeForeignConsumptionGate(deps: ForeignConsumptionGateDeps) {
  const fc = typeof deps.lib["foreignConsumption"] === "function"
    ? (deps.lib["foreignConsumption"] as ForeignConsumptionFn)
    : null;
  let reportedUnavailable = false;
  const reportUnavailable = (): void => {
    if (reportedUnavailable) return;
    reportedUnavailable = true;
    deps.log(GATE_UNAVAILABLE_LOG);
    try {
      void Promise.resolve(deps.writeGap(GATE_UNAVAILABLE_GAP)).catch((e: unknown) => {
        deps.log(`[foreign-consumption] gap write FAILED for ${GATE_UNAVAILABLE_GAP.id}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      });
    } catch (e) {
      deps.log(`[foreign-consumption] gap write FAILED for ${GATE_UNAVAILABLE_GAP.id}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
  };

  return {
    available: fc !== null,
    check(trace: TraceLike, opts: { strict: boolean }): ForeignConsumptionVerdict {
      if (!fc) {
        reportUnavailable();
        return { block: false, status: "unavailable" };
      }
      const v = fc(trace);
      if (v.status === "foreign") {
        const d = v.foreign.map((f) => `${f.taskId}<-${f.impulseId}@${f.producerExecutionId ?? "?"}`).join(",");
        return { block: true, status: "foreign", reason: `provenance:foreign-impulse-consumed — ${d.slice(0, 400)}` };
      }
      // Tasks that consumed impulses but carry no provenance. With the export present the
      // engine records it on every such task, so this is unverifiable, not legacy.
      const unverified = (trace.tasks ?? []).filter(
        (t) => t.skipped !== true && (t.inputImpulseIds?.length ?? 0) > 0 && !Array.isArray(t.consumedProvenance),
      );
      if (unverified.length > 0) {
        const reason = `provenance:unverifiable — task(s) ${unverified.map((t) => t.taskId).join(",")} consumed impulses but carry no consumedProvenance`;
        return opts.strict ? { block: true, status: "unverified", reason } : { block: false, status: "unverified", reason };
      }
      return { block: false, status: v.status === "unknown" ? "unknown" : "clean" };
    },
  };
}
