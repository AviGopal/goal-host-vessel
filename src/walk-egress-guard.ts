/**
 * THE WALK NEVER WRITES A SINGLE-WRITER POOL ROW (closed).
 *
 * development-vessel's pool store has two kinds of row that exactly one writer may create or change:
 *   - RUNNER-ONLY rows: the verdict corpus status the credit stop reads its holds from, written only under the
 *     corpus runner's grant, and the refusal records the store writes about itself;
 *   - TRUST-ROOT rows: containment, budget, holds and the other operator records, written only under an operator
 *     credential (or one named evaluator, in-process on that vessel).
 * dev-vessel decides who is writing from the request's credential. Every walk egress carries goal-host's own
 * credential, and the walk builds its pointers from pool values, goal text and model output. So a walk step that
 * targets poolImpulse_write with one of these shapes (or ids) presents goal-host's credential for a write no
 * walk ever owns: a model-steered step could forge the credit stop's input. The refusal therefore happens HERE,
 * before any byte leaves goal-host, at every walk egress whose pointer is built from synthesised args:
 *   - rawResolve (the satisfier sites, arg correction, action-then-read, the bridge sinks);
 *   - ufExecuteTool (the floor tool loop: its allowlist includes the goal's own write shapes);
 *   - the dev-vessel proxy resolver and the discovery proxy resolver (template tasks run inside a walk; the
 *     dev-vessel proxy is registered for every shape dev-vessel serves, poolImpulse_write included).
 * The check reads the OUTGOING body the way dev-vessel's route reads it (impulse.pointer, else impulse, else the
 * bare body), plus the shape the site was asked to resolve, so a model cannot move the pointer to escape it.
 *
 * Why not a satisfier-pick set like fs-write-shapes.ts: that one refuses by the resolved shape alone; this one
 * depends on the BUILT pointer's `shape` and `id`, which exist only after the args are synthesised.
 *
 * The lists mirror dev-vessel's (resolvers/pool-impulse.ts RUNNER_ONLY_POOL_SHAPES, the status id and refusal id
 * prefix runnerOnlyWriteShape matches, and TRUST_ROOT_POOL_SHAPES). They are a closed constant, not a read: no
 * shape serves the lists, and a use-time read would have to refuse every walk pool write whenever dev-vessel is
 * unreachable. test/walk-egress-single-writer.test.ts pins them against a vendored manifest (test/walk-egress/) of dev-vessel's lists and,
 * where dev-vessel's source is a sibling checkout, requires these sets to cover dev-vessel's.
 *
 * Residual (stated, not hidden): dev-vessel also classifies a write by the shape of the EXISTING row its id
 * names. For runner-only rows that is covered here (status rows live only under the status id, refusal rows only
 * under the prefix). A trust-root row under an arbitrary id is refused by dev-vessel's operator-credential check,
 * which goal-host's credential does not satisfy; this guard does not read the store to learn a row's shape.
 */

import { observeEgressRefusal, observeModeBlindRefusal, observeSkips } from "./observe-mode";

/** The write type that reaches dev-vessel's pool store from outside. */
export const POOL_WRITE_TYPE = "poolImpulse_write";

/** Runner-only pool shapes (dev-vessel RUNNER_ONLY_POOL_SHAPES). */
export const RUNNER_ONLY_POOL_SHAPES: ReadonlySet<string> = new Set(["verdictCorpusStatus", "verdictCorpusWriteRefusal"]);
/** Ids reserved for runner-only rows (dev-vessel VERDICT_CORPUS_STATUS_ID). */
export const RUNNER_ONLY_POOL_IDS: ReadonlySet<string> = new Set(["verdictCorpusStatus"]);
/** Id prefixes reserved for runner-only rows (dev-vessel's refusal-record id prefix). */
export const RUNNER_ONLY_POOL_ID_PREFIXES: readonly string[] = ["verdictCorpusWriteRefusal:"];
/** Trust-root pool shapes (dev-vessel TRUST_ROOT_POOL_SHAPES). */
export const TRUST_ROOT_POOL_SHAPES: ReadonlySet<string> = new Set([
  "substrateNodes", "autonomyScope", "spendEnvelope", "calibrationWindow", "scriptRunnerAllowlist",
  "operatorHold", "posteriorReplayAuthorization", "verdictCorpusWriter", "fedIngressAuthPolicy",
]);

/** A pool write by its type: the bare name or a vessel-qualified one ("development-vessel:poolImpulse_write"). */
export function isPoolWriteType(t: unknown): boolean {
  return typeof t === "string" && (t === POOL_WRITE_TYPE || t.endsWith(`:${POOL_WRITE_TYPE}`));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Why a pointer's shape or id names a single-writer row, or null. */
function singleWriterTarget(p: Record<string, unknown>): string | null {
  const shape = p["shape"];
  const id = p["id"];
  if (typeof shape === "string" && RUNNER_ONLY_POOL_SHAPES.has(shape)) return `${shape} is a runner-only pool shape`;
  if (typeof shape === "string" && TRUST_ROOT_POOL_SHAPES.has(shape)) return `${shape} is a trust-root pool shape`;
  if (typeof id === "string") {
    if (RUNNER_ONLY_POOL_IDS.has(id) || RUNNER_ONLY_POOL_ID_PREFIXES.some((pre) => id.startsWith(pre))) return `id ${id} is reserved for a runner-only pool row`;
    if (TRUST_ROOT_POOL_SHAPES.has(id) || RUNNER_ONLY_POOL_SHAPES.has(id)) return `id ${id} names a single-writer pool shape`;
  }
  return null;
}

/**
 * The refusal for one walk egress (pure), or null when it may go out. `shape` is what the site resolves; `body` is
 * the exact object it would POST. Refused when the write type (the site's shape, or any type the body carries) is a
 * pool write AND any pointer the receiving route could read (impulse.pointer, impulse, the bare body) names a
 * runner-only or trust-root shape, or a reserved id.
 */
export function walkEgressRefusal(shape: string, body: unknown): string | null {
  const b = asRecord(body);
  const imp = asRecord(b?.["impulse"]);
  const ptr = asRecord(imp?.["pointer"]);
  const candidates = [ptr, imp, b].filter((x): x is Record<string, unknown> => x !== null);
  const isWrite = isPoolWriteType(shape) || candidates.some((c) => isPoolWriteType(c["type"]));
  if (!isWrite) return null;
  for (const c of candidates) {
    const why = singleWriterTarget(c);
    if (why) return `single-writer: refused before egress — a walk may not write ${why} (only its own writer does)`;
  }
  return null;
}

/** The dispatch's learning mode and id, read from goal-host's dispatch context (set by setWalkEgressLearningModeReader,
 *  the same pattern as llm-router's setRouterDispatchIdReader). Unset reads as no mode: nothing is refused for it. */
type DispatchModeRead = { learningMode?: unknown; dispatchId?: string } | undefined;
let readLearningMode: () => DispatchModeRead = () => undefined;
export function setWalkEgressLearningModeReader(reader: () => DispatchModeRead): void { readLearningMode = reader; }

/** Thrown by walkEgressFetch instead of sending; each site maps it to its own failure path. */
export class WalkEgressRefused extends Error {
  readonly refused = true;
  constructor(readonly shape: string, reason: string) { super(reason); this.name = "WalkEgressRefused"; }
}

/** The body of a fetch init as an object, for the check (a string body is parsed; an unparseable one is checked as absent). */
function bodyOf(init: RequestInit | undefined): unknown {
  const raw = init?.body;
  if (typeof raw !== "string") return undefined;
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

/** The one line a refusal is logged with when the site has no log of its own: shape and site only (never args,
 *  body or credential). */
export function walkEgressRefusalLine(shape: string, site: string): string {
  return `[walk-egress] REFUSED shape=${shape} site=${site}`;
}

/**
 * fetch() for a walk egress: checks the outgoing body first and throws WalkEgressRefused WITHOUT calling fetch when
 * it would write a single-writer pool row. Every walk egress whose pointer is synthesised goes through this.
 * `site` is given by a site whose failure path is a bare throw (the proxy resolvers): the refusal is then logged
 * here, once, before the throw. Sites that log their own refusal (rawResolve, the floor tool loop) omit it.
 */
export async function walkEgressFetch(shape: string, url: string, init: RequestInit, site?: string): Promise<Response> {
  // OBSERVE (observe-mode.ts): an observe dispatch's walk writes no gap and hands no work to a resolver that ignores
  // the mode; refused here, before egress, like the above.
  let ctx: DispatchModeRead;
  try { ctx = readLearningMode(); } catch { ctx = undefined; }
  const observeWhy = observeEgressRefusal(ctx?.learningMode, shape, bodyOf(init));
  if (observeWhy) observeSkips(ctx?.learningMode, ctx?.dispatchId, "gap_write");
  const blindWhy = observeWhy ? null : observeModeBlindRefusal(ctx?.learningMode, shape, bodyOf(init));
  if (blindWhy) observeSkips(ctx?.learningMode, ctx?.dispatchId, "mode_blind_dispatch");
  const why = walkEgressRefusal(shape, bodyOf(init)) ?? observeWhy ?? blindWhy;
  if (why) {
    if (site) console.log(walkEgressRefusalLine(shape, site));
    throw new WalkEgressRefused(shape, why);
  }
  return await fetch(url, init);
}

/** Whether an error is this guard's refusal (a non-transient failure: never retried). */
export function isWalkEgressRefused(e: unknown): e is WalkEgressRefused {
  return e instanceof WalkEgressRefused || (asRecord(e)?.["refused"] === true && (e as Error)?.name === "WalkEgressRefused");
}
