/**
 * THE CREDIT STOP, READ AT USE TIME (closed).
 *
 * A red verdict-corpus case holds learning for its own credit class: a red case that expects hollow (the
 * judge says reached) holds REACH-direction credit (α, goal-path success, ribosome mint, REUSE donor
 * eligibility); a red control holds HOLLOW-direction credit (β, goal-path failure, hollow penalties). The
 * judge's verdict is still delivered; only learning from it is withheld.
 *
 * The holds are read from the `verdictCorpusStatus` pool record on development-vessel. Only goal-host's own
 * principal can write it (dev-vessel pool-impulse.ts, the runner grant), and dev-vessel's open poolImpulse read
 * marks it attested_verified only under that grant's signed stamp. A refresher (refreshStatusFromPool, injected
 * fetch, no network I/O here) keeps the LAST GOOD verified record in memory; it runs at boot, on the hold refresh
 * tick (REFRESH_TICK_MS) and after every runner write, never from a credit site (a credit site starts no network
 * call, so the walk's call order is unchanged). Every credit site reads that copy SYNCHRONOUSLY, cached for at most HOLD_CACHE_TTL_MS: a credit site that consults the
 * hold must not gain an await, or the order of the walk's fire-and-forget writes would change. Not an env var, not
 * a constant, and NOT a file: the shaped-policy file goal-host writes is a cache for readers that want it and is
 * never read for a hold, so a module that writes "no holds" there changes nothing.
 *   - a last-good copy not refreshed for STALE_REFRESH_TICKS ticks is treated as missing (below);
 *   - stale (run_at older than STALE_PERIODS x period_s): the last holds are kept, never treated as green;
 *   - missing or unreadable: ONLY the classes of EVER-RED cases are held (recorded red at append and never
 *     published green), it is logged loudly, and one high-severity "status unavailable" gap is filed. A class
 *     no case has ever been red for is never held: learning is never held wholesale;
 *   - every hold carries `since` and `review_by`; it lifts only when the runner observes its case green.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isUsablePolicy, shapedPolicyPath } from "../shaped-policy-store";
import { classesForGoal } from "./credit-classes";
import { everRedCases, everRedHolds, loadCorpus, type Hold, type HoldDirection } from "./corpus-runner";
import { verdictCorpusDir } from "./corpus-location";

export const STATUS_SHAPE = "verdictCorpusStatus";
export const HOLD_CACHE_TTL_MS = 60_000;
export const STALE_PERIODS = 3;
export const DEFAULT_PERIOD_S = 21_600;

export interface VerdictCorpusStatus {
  schema: 1;
  node: string;
  judge_sha: string;
  deployed_sha: string | null;
  corpus: { n: number; link: string };
  /** Cases by fidelity: how many replay a recorded judge input, a harness call, or only a paraphrase. */
  fidelity: Record<string, number>;
  run_at: string;
  period_s: number;
  ever_green: "present" | "absent (fail closed)";
  state: "ok" | "corpus_unreadable" | "runner_failed";
  green: string[];
  flips: string[];
  known_red: string[];
  entry_missing: string[];
  holds: Hold[];
  live_shadow: { sampled: number; mismatched: number };
}

export interface HoldView { holds: Hold[]; source: "status" | "stale" | "unreadable" }

/** Where the deployed corpus is read: the vessel CLONE's test/verdict-corpus/ (corpus-location.ts), never a path relative
 *  to this module. The deployed mirror carries src/ only, so a module-relative test/ path names nothing on a running node. */
export const DEPLOYED_CORPUS_DIR = verdictCorpusDir();

type Reader = () => Record<string, unknown> | null;
type EverGreenReader = () => string[] | null;
type UnavailableHook = (why: string, holds: Hold[]) => void;

/** The workspace root, as the shaped-policy store resolves it (no environment read of its own). */
export function workspaceRoot(): string { return dirname(dirname(shapedPolicyPath(STATUS_SHAPE))); }
/** The gate's published ever-green set: a FIXED path (the constant pull-sync publishes to and development-vessel
 *  reads), never relative to WORKSPACE_ROOT, so every reader names the same file whatever its workspace root is. */
export const GATE_PUBLIC_DIR = "/workspace/.gate-public";
export const everGreenPath = (vessel = "goal-host-vessel"): string => `${GATE_PUBLIC_DIR}/verdict-corpus-green.${vessel}.json`;
export function parseEverGreen(text: string): string[] | null {
  try {
    const v = JSON.parse(text) as unknown;
    const ids = Array.isArray(v) ? v : (v as { ever_green?: unknown })?.ever_green;
    return Array.isArray(ids) && ids.every((x) => typeof x === "string") ? (ids as string[]) : null;
  } catch { return null; }
}
/** The gate's published ever-green ids, read synchronously; null when none is published. */
export function readEverGreenSync(path = everGreenPath()): string[] | null {
  try { return parseEverGreen(readFileSync(path, "utf8")); } catch { return null; }
}
/** The status record's pool id and the runner path's source label (dev-vessel pool-impulse.ts, the runner grant). */
export const STATUS_ID = "verdictCorpusStatus";
export const STATUS_SOURCE = "verdictCorpusRun";
/** The hold refresh tick: the cadence the last-good copy is re-read from the pool. */
export const REFRESH_TICK_MS = HOLD_CACHE_TTL_MS;
/** A last-good copy older than this many refresh ticks (counted from its last verified fetch) is missing. */
export const STALE_REFRESH_TICKS = 5;

/**
 * The verified status in a dev-vessel poolImpulse read (pure): the open row of this shape under STATUS_ID that the
 * route marked attested_verified under the runner's stamp, with a usable body. Anything else is no status, and why.
 */
export function statusFromPoolRead(j: unknown): { status: Record<string, unknown>; why?: undefined } | { status: null; why: string } {
  const imps = (j as { body?: { impulses?: unknown } } | null)?.body?.impulses;
  if (!Array.isArray(imps)) return { status: null, why: "the pool read carried no impulses" };
  const row = imps.find((r) => r && typeof r === "object" && (r as Record<string, unknown>)["id"] === STATUS_ID && (r as Record<string, unknown>)["shape"] === STATUS_SHAPE) as Record<string, unknown> | undefined;
  if (!row) return { status: null, why: "development-vessel holds no verdictCorpusStatus record" };
  if (row["status"] !== "open") return { status: null, why: `the record is ${String(row["status"])}` };
  if (row["attested_verified"] !== true || (row["attested"] as { by?: unknown } | undefined)?.by !== "runner") return { status: null, why: "the record is not verified under the runner grant's stamp" };
  const b = row["body"];
  if (!isUsablePolicy(b) || !Array.isArray((b as Record<string, unknown>)["holds"]) || typeof (b as Record<string, unknown>)["run_at"] !== "string") return { status: null, why: "the record's body is not a readable status" };
  return { status: b as Record<string, unknown> };
}

type PoolFetcher = () => Promise<unknown>;
let poolFetcher: PoolFetcher | null = null;
let onRefreshed: (status: Record<string, unknown>) => void = () => {};
let lastGood: { status: Record<string, unknown>; fetchedAtMs: number } | null = null;
let lastRefreshWhy: string | null = null;
let refreshing: Promise<{ ok: boolean; why?: string }> | null = null;

/**
 * Re-read the status from the pool (one at a time). A verified record replaces the last-good copy; anything else
 * (development-vessel unreachable, no record, an unverified row) leaves the last-good copy to age.
 */
export function refreshStatusFromPool(): Promise<{ ok: boolean; why?: string }> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!poolFetcher) return { ok: false, why: "no pool reader is configured" };
    let r: ReturnType<typeof statusFromPoolRead>;
    try { r = statusFromPoolRead(await poolFetcher()); } catch (e) { r = { status: null, why: `development-vessel unreadable: ${String((e as Error)?.message ?? e).slice(0, 200)}` }; }
    if (r.status) {
      lastGood = { status: r.status, fetchedAtMs: clock() };
      lastRefreshWhy = null;
      cache = null;
      try { onRefreshed(r.status); } catch { /* the cache file never changes a hold */ }
      return { ok: true };
    }
    if (r.why !== lastRefreshWhy) console.warn(`[verdict-corpus] status refresh from development-vessel failed: ${r.why}; the last verified copy ${lastGood ? `(fetched ${new Date(lastGood.fetchedAtMs).toISOString()})` : "(none)"} is kept until ${STALE_REFRESH_TICKS} refresh ticks old`);
    lastRefreshWhy = r.why;
    return { ok: false, why: r.why };
  })();
  return refreshing.finally(() => { refreshing = null; });
}

/** The last verified status regardless of age (the runner carries its holds forward from it), or null. */
export function lastVerifiedStatus(): Record<string, unknown> | null { return lastGood?.status ?? null; }

/** Why the default reader has no status (folded into the unavailable report), or null. */
function poolMissingWhy(): string | null {
  if (!lastGood) return `no verified record read from development-vessel${lastRefreshWhy ? ` (${lastRefreshWhy})` : ""}`;
  const age = clock() - lastGood.fetchedAtMs;
  return age > STALE_REFRESH_TICKS * REFRESH_TICK_MS ? `the last verified copy is ${Math.round(age / 1000)} s old, past ${STALE_REFRESH_TICKS} refresh ticks${lastRefreshWhy ? ` (${lastRefreshWhy})` : ""}` : null;
}

/** The default reader: the last verified pool status, synchronously; null (missing) when none was ever read or the
 *  copy is past STALE_REFRESH_TICKS ticks. Never a file. */
export function readStatusSync(): Record<string, unknown> | null {
  return poolMissingWhy() === null ? lastGood!.status : null;
}

/** The goal-host-written status file, for cache readers only (never consulted for a hold). */
export function readStatusCacheFileSync(): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(shapedPolicyPath(STATUS_SHAPE), "utf8")) as unknown;
    return isUsablePolicy(v) ? v : null;
  } catch { return null; }
}
let reader: Reader = readStatusSync;
let everGreenReader: EverGreenReader = () => readEverGreenSync();
let onUnavailable: UnavailableHook = () => {};
let unavailableReported = false;
let corpusDir = DEPLOYED_CORPUS_DIR;
let clock: () => number = () => Date.now();
let cache: { at: number; view: HoldView } | null = null;

/** Drop the cached view (the runner calls this after it writes a new status). */
export function invalidateHolds(): void { cache = null; }

/** Test seam: a different status reader / corpus dir / clock; resets the cache. */
export function configureCreditHold(o: { reader?: Reader; corpusDir?: string; clock?: () => number; everGreen?: EverGreenReader; onUnavailable?: UnavailableHook; poolFetcher?: PoolFetcher; onRefreshed?: (status: Record<string, unknown>) => void; resetPoolCopy?: boolean }): void {
  if (o.resetPoolCopy) { lastGood = null; lastRefreshWhy = null; poolFetcher = null; onRefreshed = () => {}; }
  if (o.reader) reader = o.reader;
  if (o.poolFetcher) poolFetcher = o.poolFetcher;
  if (o.onRefreshed) onRefreshed = o.onRefreshed;
  if (o.everGreen) everGreenReader = o.everGreen;
  if (o.onUnavailable) { onUnavailable = o.onUnavailable; unavailableReported = false; }
  if (o.corpusDir) corpusDir = o.corpusDir;
  if (o.clock) clock = o.clock;
  cache = null;
}

/** Interpret a status record (pure). */
export function holdView(status: Record<string, unknown> | null, nowMs: number, dir: string, everGreen: ReadonlySet<string> | null = null): HoldView {
  if (!status || !Array.isArray(status["holds"]) || typeof status["run_at"] !== "string") {
    return { holds: everRedHolds(loadCorpus(dir).cases, everGreen, new Date(nowMs).toISOString()), source: "unreadable" };
  }
  const period = typeof status["period_s"] === "number" && status["period_s"] > 0 ? status["period_s"] : DEFAULT_PERIOD_S;
  const runAt = Date.parse(status["run_at"]);
  const stale = !Number.isFinite(runAt) || nowMs - runAt > STALE_PERIODS * period * 1000;
  return { holds: status["holds"] as Hold[], source: stale ? "stale" : "status" };
}

export function currentHolds(): HoldView {
  const now = clock();
  if (cache && now - cache.at < HOLD_CACHE_TTL_MS) return cache.view;
  let status: Record<string, unknown> | null = null;
  try { status = reader(); } catch { status = null; }
  let eg: string[] | null = null;
  if (!status || !Array.isArray(status["holds"])) { try { eg = everGreenReader(); } catch { eg = null; } }
  const view = holdView(status, now, corpusDir, eg ? new Set(eg) : null);
  if (view.source === "stale") console.warn(`[verdict-corpus] STALE status — ${view.holds.length} hold(s) kept; never treated as green`);
  if (view.source === "unreadable") {
    const classes = view.holds.map((h) => `${h.credit_class}:${h.direction}`).join(",");
    console.warn(`[verdict-corpus] STATUS UNAVAILABLE — the runner's verdictCorpusStatus is missing or unreadable; holding ONLY the ever-red classes [${classes}] (${everRedCases(loadCorpus(corpusDir).cases, eg ? new Set(eg) : null).length} ever-red case(s), ever-green record ${eg ? "present" : "absent"}); every other class keeps learning`);
    if (!unavailableReported) {
      unavailableReported = true;
      const detail = reader === readStatusSync ? poolMissingWhy() : null;
      try { onUnavailable(status ? "status record malformed" : detail ? `status record missing: ${detail}` : "status record missing", view.holds); } catch { /* reporting never changes a hold */ }
    }
  } else unavailableReported = false;
  cache = { at: now, view };
  return view;
}

export interface HeldDecision { credit_class: string; direction: HoldDirection; case_ids: string[]; source: HoldView["source"] }

/** Is credit in `direction` held for any of `classes`? Logs and returns the hold, or null. */
export function heldFor(classes: readonly string[], direction: HoldDirection, site: string): HeldDecision | null {
  if (classes.length === 0) return null;
  const v = currentHolds();
  const h = v.holds.find((x) => x.direction === direction && classes.includes(x.credit_class));
  if (!h) return null;
  console.log(`[verdict-corpus] CREDIT HELD class=${h.credit_class} dir=${direction} case=${h.case_ids.slice(0, 3).join(",")} site=${site} source=${v.source}`);
  return { credit_class: h.credit_class, direction, case_ids: h.case_ids, source: v.source };
}

/** heldFor over the classes the core noted for this goal's verdicts. */
export function heldForGoal(goal: string | undefined | null, direction: HoldDirection, site: string): HeldDecision | null {
  return heldFor(classesForGoal(goal), direction, site);
}
