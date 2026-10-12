/**
 * THE CREDIT STOP, READ AT USE TIME (closed).
 *
 * A red verdict-corpus case holds learning for its own credit class: a red case that expects hollow (the
 * judge says reached) holds REACH-direction credit (α, goal-path success, ribosome mint, REUSE donor
 * eligibility); a red control holds HOLLOW-direction credit (β, goal-path failure, hollow penalties). The
 * judge's verdict is still delivered; only learning from it is withheld.
 *
 * The holds are read from the shaped `verdictCorpusStatus` record (written only by the corpus runner) at
 * every credit site from the shaped-policy store (the file resolveShapedPolicy reads), cached for at most
 * HOLD_CACHE_TTL_MS. Not an env var, not a constant. The read is SYNCHRONOUS on purpose: a credit site that
 * consults the hold must not gain an await, or the order of the walk's fire-and-forget writes would change.
 *   - stale (run_at older than STALE_PERIODS x period_s): the last holds are kept, never treated as green;
 *   - missing or unreadable: ONLY the classes of EVER-RED cases are held (recorded red at append and never
 *     published green), it is logged loudly, and one high-severity "status unavailable" gap is filed. A class
 *     no case has ever been red for is never held: learning is never held wholesale;
 *   - every hold carries `since` and `review_by`; it lifts only when the runner observes its case green.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isUsablePolicy, shapedPolicyPath } from "../shaped-policy-store";
import { classesForGoal } from "./credit-classes";
import { everRedCases, everRedHolds, loadCorpus, type Hold, type HoldDirection } from "./corpus-runner";

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

/** Where the deployed corpus lives, relative to this module (src/judge/ -> test/verdict-corpus/). */
export const DEPLOYED_CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "verdict-corpus");

type Reader = () => Record<string, unknown> | null;
type EverGreenReader = () => string[] | null;
type UnavailableHook = (why: string, holds: Hold[]) => void;

/** The workspace root, as the shaped-policy store resolves it (no environment read of its own). */
export function workspaceRoot(): string { return dirname(dirname(shapedPolicyPath(STATUS_SHAPE))); }
export const everGreenPath = (vessel = "goal-host-vessel"): string => join(workspaceRoot(), ".gate-public", `verdict-corpus-green.${vessel}.json`);
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
/** The shaped status record, read synchronously from where resolveShapedPolicy reads it; absent/corrupt = null. */
export function readStatusSync(): Record<string, unknown> | null {
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
export function configureCreditHold(o: { reader?: Reader; corpusDir?: string; clock?: () => number; everGreen?: EverGreenReader; onUnavailable?: UnavailableHook }): void {
  if (o.reader) reader = o.reader;
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
      try { onUnavailable(status ? "status record malformed" : "status record missing", view.holds); } catch { /* reporting never changes a hold */ }
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
