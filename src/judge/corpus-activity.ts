/**
 * THE VERDICT CORPUS RUNNER ACTIVITY (closed): replay the deployed corpus against the LIVE, in-process judge
 * entries, publish the verdictCorpusStatus record the credit hold reads, record a traced report, and file one
 * gap per red case.
 *
 * Triggered by a resolve of the `verdictCorpusRun` shape (the rhythm conductor's time-shaped impulse) and once
 * at goal-host boot. Every sink is injected by the host, so this module does no network I/O of its own.
 *
 *   - a manifest that is absent or does not verify: state corpus_unreadable, only the classes of the ever-red
 *     cases it could load are held (else the previous holds are kept), and a runner-failed gap is filed;
 *   - no ever-green set (an ungated node, or before the first publish): every red case is a flip except one
 *     recorded red at append (fail closed, stated in the status);
 *   - a hold past review_by escalates its gap; it is never silently dropped.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, everRedHolds, fidelityCounts, holdsFrom, loadCorpus, replayCase, type CorpusCase, type Hold } from "./corpus-runner";
import { scopeEntryFor } from "../escalation-target";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { shapedPolicyPath } from "../shaped-policy-store";
import { DEFAULT_PERIOD_S, STATUS_SHAPE, everGreenPath, parseEverGreen, type VerdictCorpusStatus } from "./credit-hold";

export interface CorpusGap {
  id: string;
  severity: "high" | "normal";
  category: string;
  summary: string;
  edit_site: string | null;
  falsifier: CaseFalsifier | null;
  case_id: string | null;
  credit_class: string | null;
  /** The machine check dev-vessel runs (null for the runner's own failure gaps: they close by a clean run). */
  evidence_resolve: CaseEvidenceResolve | null;
  /** Who works this gap: operator review while its edit site is closed (or the scope cannot be read), else the lane. */
  route: GapRoute;
}

/** A class1 machine check: the red case replayed by the corpus runner. The case defines done. */
/** The armed falsifier (dev-vessel reads `.class`). Provenance only beyond `class`: the machine check itself is the
 *  gap's evidence_resolve, which the compose own-check and the land verdict run. */
export interface CaseFalsifier { class: "class1"; check: "verdict-corpus-case" | "verdict-corpus-run"; case_id: string | null }

/** The class1 machine check of a red case: the case-check file run alone, judged on exactly that case's test. */
export const CASE_CHECK_FILE = "test/verdict-corpus/case-check.check.ts";
export interface CaseEvidenceResolve { shape: "test_suite"; input: { vessel: "repos/goal-host-vessel"; test_file: string; only_tests: string[]; timeout_ms: number }; zero_field: "requested_not_passing" }
export const evidenceFor = (id: string): CaseEvidenceResolve => ({ shape: "test_suite", input: { vessel: "repos/goal-host-vessel", test_file: CASE_CHECK_FILE, only_tests: [id], timeout_ms: 60_000 }, zero_field: "requested_not_passing" });

/** The parking disposition dev-vessel's compose eligibility honours, and the marker that says THIS runner set it. */
export const RUNNER_PARK = "awaiting_operator_review";
export const RUNNER_ID = "verdict-corpus-runner";
export const dispositionFor = (route: GapRoute): string => (route.to === "operator_review" ? RUNNER_PARK : "");

/** What the store holds for a gap id: the row, null when absent, or "unreadable". */
export type GapRow = { status?: unknown; severity?: unknown; classification_metadata?: Record<string, unknown> };

/**
 * RE-DERIVED ON EVERY RUN: whether this runner (re)writes one of its own gaps. The disposition follows the live
 * opening state (closed or unreadable scope = parked, open = ""), written explicitly because the gap store carries
 * omitted keys forward. Only a disposition this runner owns is changed: "" or its own park (parked_by = this
 * runner). Any other hold (a human's park, a landing awaiting its verdict, a check being supplied) is left alone,
 * and a gap that is no longer open is never reopened. An unreadable row is written only to PARK (fail closed).
 */
export function planGapWrite(row: GapRow | null | "unreadable", g: CorpusGap): { write: boolean; why: string } {
  const want = dispositionFor(g.route);
  if (row === "unreadable") return want === RUNNER_PARK ? { write: true, why: "row unreadable; parking (fail closed)" } : { write: false, why: "row unreadable; never release blind" };
  if (row === null) return { write: true, why: "new" };
  if (String(row.status ?? "open") !== "open") return { write: false, why: `not open (${String(row.status)})` };
  const meta = row.classification_metadata ?? {};
  const cur = typeof meta["disposition"] === "string" ? (meta["disposition"] as string) : "";
  const ours = cur === "" || (cur === RUNNER_PARK && meta["parked_by"] === RUNNER_ID);
  if (!ours) return { write: false, why: `held by someone else (${cur})` };
  if (cur !== want) return { write: true, why: want ? "park: the edit site is closed" : "release: the edit site opened" };
  if (String(row.severity ?? "") !== g.severity) return { write: true, why: "severity changed" };
  return { write: false, why: "unchanged" };
}

export interface GapRoute { to: "operator_review" | "lane"; reason: string; scope_entry: string | null }

/**
 * Route a gap by the judge opening state, read at use time from the live autonomyScope record (law 1): an edit
 * site under an excluded entry (the closed core always; src/judge-rules/ until the opening act) goes to operator
 * review; an open one goes to the lane. An unreadable scope routes to operator review (fail closed).
 */
export function routeGap(editSite: string | null, excluded: readonly string[] | null): GapRoute {
  if (!editSite) return { to: "operator_review", reason: "no edit site", scope_entry: null };
  if (excluded === null) return { to: "operator_review", reason: "the autonomy scope could not be read (fail closed)", scope_entry: null };
  const entry = scopeEntryFor(editSite, excluded);
  if (entry) return { to: "operator_review", reason: `the edit site is closed (excluded by ${entry})`, scope_entry: entry };
  return { to: "lane", reason: "the edit site is open to the lane", scope_entry: null };
}

export interface CorpusSinks {
  readPreviousStatus(): Promise<Record<string, unknown> | null>;
  readEverGreen(): Promise<string[] | null>;
  /** The live autonomyScope excluded paths (the opening state), or null when unreadable. */
  readScopeExcluded(): Promise<string[] | null>;
  writeStatus(s: VerdictCorpusStatus): Promise<void>;
  recordReport(report: VerdictCorpusReport): Promise<void>;
  fileGap(g: CorpusGap): Promise<void>;
  /** The store's current row for a gap id (null = absent, "unreadable" = the read failed). */
  readGap(id: string): Promise<GapRow | null | "unreadable">;
}

export interface VerdictCorpusReport {
  shape: "verdictCorpusReport";
  trigger: string;
  status: VerdictCorpusStatus;
  red: Array<{ id: string; outcome: string; diffs: string[] }>;
  ms: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** sha256 over the loaded judge sources (src/judge/ + src/judge-rules/), so a status names the judge it ran. */
export function judgeSourcesSha(srcDir = join(HERE, "..")): string {
  const h = createHash("sha256");
  for (const d of ["judge", "judge-rules"]) {
    let names: string[] = [];
    try { names = readdirSync(join(srcDir, d)).filter((f) => f.endsWith(".ts")).sort(); } catch { /* absent */ }
    for (const f of names) {
      const p = join(srcDir, d, f);
      if (!statSync(p).isFile()) continue;
      h.update(`${d}/${f}\n`).update(readFileSync(p));
    }
  }
  return h.digest("hex");
}

export const falsifierFor = (id: string): CaseFalsifier => ({ class: "class1", check: "verdict-corpus-case", case_id: id });
const CHAIN_FALSIFIER: CaseFalsifier = { class: "class1", check: "verdict-corpus-run", case_id: null };

export async function runVerdictCorpusActivity(o: { dir: string; node: string; deployedSha: string | null; trigger: string; nowMs: number; periodS?: number; sinks: CorpusSinks }): Promise<VerdictCorpusStatus> {
  const t0 = performance.now();
  const nowIso = new Date(o.nowMs).toISOString();
  const period = o.periodS && o.periodS > 0 ? o.periodS : DEFAULT_PERIOD_S;
  let prevHolds: Hold[] = [];
  try {
    const prev = await o.sinks.readPreviousStatus();
    if (prev && Array.isArray(prev["holds"])) prevHolds = prev["holds"] as Hold[];
  } catch { /* no previous status */ }
  const base = { schema: 1 as const, node: o.node, judge_sha: judgeSourcesSha(), deployed_sha: o.deployedSha, run_at: nowIso, period_s: period, live_shadow: { sampled: 0, mismatched: 0 } };
  let everGreenList: string[] | null = null;
  try { everGreenList = await o.sinks.readEverGreen(); } catch { everGreenList = null; }
  const egSet = everGreenList ? new Set(everGreenList) : null;
  let excluded: string[] | null = null;
  try { excluded = await o.sinks.readScopeExcluded(); } catch { excluded = null; }
  const route = (site: string | null) => routeGap(site, excluded);
  const tally = { written: 0, parked: 0, released: 0, unchanged: 0, left: 0 };
  /** File or re-derive one of this runner's gaps (every run). */
  const put = async (g: CorpusGap): Promise<void> => {
    let row: GapRow | null | "unreadable";
    try { row = await o.sinks.readGap(g.id); } catch { row = "unreadable"; }
    const plan = planGapWrite(row, g);
    if (!plan.write) { if (plan.why === "unchanged") tally.unchanged++; else tally.left++; return; }
    tally.written++;
    if (/^park/.test(plan.why)) tally.parked++;
    if (/^release/.test(plan.why)) tally.released++;
    await o.sinks.fileGap(g);
  };
  try {
    const lc = loadCorpus(o.dir);
    if (!lc.ok) {
      const status: VerdictCorpusStatus = { ...base, corpus: lc.head, fidelity: fidelityCounts(lc.cases), ever_green: "absent (fail closed)", state: "corpus_unreadable", green: [], flips: [], known_red: [], entry_missing: [], holds: lc.cases.length > 0 ? everRedHolds(lc.cases, egSet, nowIso) : prevHolds };
      console.warn(`[verdict-corpus] CORPUS UNREADABLE node=${o.node} — only the ever-red classes it could load are held: ${lc.errors.slice(0, 3).join("; ")}`);
      await o.sinks.writeStatus(status);
      await o.sinks.recordReport({ shape: "verdictCorpusReport", trigger: o.trigger, status, red: [], ms: performance.now() - t0 });
      await put({ id: `verdict-corpus-runner-failed-${o.node}`, severity: "high", category: "judge_regression", summary: `The verdict corpus on ${o.node} is unreadable (${lc.errors.slice(0, 3).join("; ")}); the classes of ever-red cases are held until a run verifies it.`, edit_site: "repos/goal-host-vessel/src/judge/corpus-runner.ts", falsifier: CHAIN_FALSIFIER, case_id: null, credit_class: null, evidence_resolve: null, route: route("repos/goal-host-vessel/src/judge/corpus-runner.ts") });
      return status;
    }
    const results = lc.cases.map((c) => replayCase(c));
    const cl = classify(lc.cases, results, everGreenList ? new Set(everGreenList) : null);
    const holds = holdsFrom(lc.cases, cl, nowIso, prevHolds);
    const status: VerdictCorpusStatus = { ...base, corpus: lc.head, fidelity: fidelityCounts(lc.cases), ever_green: everGreenList ? "present" : "absent (fail closed)", state: "ok", green: cl.green, flips: cl.flips, known_red: cl.known_red, entry_missing: cl.entry_missing, holds };
    await o.sinks.writeStatus(status);
    const red = results.filter((r) => r.outcome !== "green").map((r) => ({ id: r.id, outcome: r.outcome, diffs: r.diffs }));
    await o.sinks.recordReport({ shape: "verdictCorpusReport", trigger: o.trigger, status, red, ms: performance.now() - t0 });
    const byId = new Map<string, CorpusCase>(lc.cases.map((c) => [c.id, c]));
    const overdue = new Set(holds.filter((h) => Date.parse(h.review_by) < o.nowMs).flatMap((h) => h.case_ids));
    for (const id of cl.flips) {
      const c = byId.get(id)!;
      await put({ id: `verdict-corpus-flip-${id}`, severity: "high", category: "judge_regression", summary: `The judge regressed: verdict-corpus case ${id} (class ${c.class}) was green and is red at the live judge. Its credit class ${c.credit_class} is held until the case is green again.`, edit_site: c.edit_site, falsifier: falsifierFor(id), case_id: id, credit_class: c.credit_class, evidence_resolve: evidenceFor(id), route: route(c.edit_site) });
    }
    for (const id of [...cl.known_red, ...cl.entry_missing]) {
      const c = byId.get(id)!;
      const late = overdue.has(id);
      await put({ id: `verdict-corpus-red-${id}`, severity: late ? "high" : "normal", category: "judge_regression", summary: `Verdict-corpus case ${id} (class ${c.class}) is red at the live judge${late ? ", and its credit hold is past its review date" : ""}. Its credit class ${c.credit_class} is held until the case is green.`, edit_site: c.edit_site, falsifier: falsifierFor(id), case_id: id, credit_class: c.credit_class, evidence_resolve: evidenceFor(id), route: route(c.edit_site) });
    }
    console.log(`[verdict-corpus] run node=${o.node} trigger=${o.trigger} cases=${lc.cases.length} green=${cl.green.length} flips=${cl.flips.length} known_red=${cl.known_red.length} entry_missing=${cl.entry_missing.length} holds=${holds.length} ever_green=${status.ever_green} fidelity=${JSON.stringify(status.fidelity)} gaps=${JSON.stringify(tally)}`);
    return status;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.warn(`[verdict-corpus] RUNNER FAILED node=${o.node}: ${msg}`);
    const status: VerdictCorpusStatus = { ...base, corpus: { n: 0, link: "0".repeat(64) }, fidelity: {}, ever_green: "absent (fail closed)", state: "runner_failed", green: [], flips: [], known_red: [], entry_missing: [], holds: prevHolds };
    try { await o.sinks.writeStatus(status); } catch { /* the stale status keeps its holds */ }
    try { await put({ id: `verdict-corpus-runner-failed-${o.node}`, severity: "high", category: "judge_regression", summary: `The verdict corpus runner failed on ${o.node}: ${msg.slice(0, 300)}. The last holds are kept.`, edit_site: "repos/goal-host-vessel/src/judge/corpus-activity.ts", falsifier: CHAIN_FALSIFIER, case_id: null, credit_class: null, evidence_resolve: null, route: route("repos/goal-host-vessel/src/judge/corpus-activity.ts") }); } catch { /* logged above */ }
    return status;
  }
}

// ── the file sinks (the shaped status record and the gate's published ever-green set) ─────────────────

/** The gate's published ever-green ids, or null when none is published (fail closed downstream). */
export async function readEverGreenFile(path = everGreenPath()): Promise<string[] | null> {
  try { return parseEverGreen(await readFile(path, "utf8")); } catch { return null; }
}

/** Write the status record where resolveShapedPolicy reads it, atomically (tmp + rename). */
export async function writeStatusFile(s: VerdictCorpusStatus, path = shapedPolicyPath(STATUS_SHAPE)): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2) + "\n");
  await rename(tmp, path);
}

// ── the verdictCorpusRun resolve: acknowledge at once, run asynchronously, one at a time ─────────────────────────

/** The trigger a verdictCorpusRun resolve names: the pointer's (impulse-resolve posts {pointer}), else the body's. */
export function triggerOf(pointer: Record<string, unknown> | null | undefined, body: Record<string, unknown> | null | undefined): string {
  const t = pointer?.["trigger"] ?? body?.["trigger"];
  return typeof t === "string" && t.trim() ? t.trim().slice(0, 40) : "rhythm";
}

/** Whether the caller is an activity template (the seeded runner template posts {pointer} through impulse-resolve). */
export function viaTemplate(pointer: Record<string, unknown> | null | undefined): boolean {
  return typeof pointer?.["template_id"] === "string" || typeof pointer?.["templateId"] === "string" || pointer?.["via"] === "template";
}

export interface RunAck {
  accepted: true;
  status: "accepted" | "in_flight";
  run_id: string;
  trigger: string;
  /** The template-execution wrapper is not a graded run of anything: the runner's own trace (run_id) carries the
   *  outcome. Stated here so the wrapper's caller can tag its trace; the wrapper itself is not goal-host's to write. */
  gradable: false;
}

/**
 * Accept a run request IMMEDIATELY and start the replay asynchronously. Single-flight: a request while a run is in
 * flight is acknowledged with that run's id. The caller never waits on the replay (impulse-resolve aborts at its own
 * timeout); the run reports through its own trace and status.
 */
export function createRunAcceptor(start: (trigger: string, runId: string) => Promise<unknown>, idOf: () => string) {
  let inflight: { runId: string; done: Promise<unknown> } | null = null;
  return {
    accept(trigger: string): RunAck {
      if (inflight) return { accepted: true, status: "in_flight", run_id: inflight.runId, trigger, gradable: false };
      const runId = idOf();
      const done = (async () => { try { return await start(trigger, runId); } catch (e) { console.warn(`[verdict-corpus] RUNNER FAILED run=${runId}: ${(e as Error)?.message ?? e}`); return null; } finally { inflight = null; } })();
      inflight = { runId, done };
      return { accepted: true, status: "accepted", run_id: runId, trigger, gradable: false };
    },
    /** The in-flight run (null when none): tests and boot await it. */
    current(): Promise<unknown> | null { return inflight?.done ?? null; },
  };
}
