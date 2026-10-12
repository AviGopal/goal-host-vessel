/**
 * THE VERDICT CORPUS RUNNER ACTIVITY (closed): replay the deployed corpus against the LIVE, in-process judge
 * entries, publish the verdictCorpusStatus record the credit hold reads, record a traced report, and file one
 * gap per red case.
 *
 * Triggered by a resolve of the `verdictCorpusRun` shape (the rhythm conductor's time-shaped impulse) and once
 * at goal-host boot. Every sink is injected by the host, so this module does no network I/O of its own.
 *
 *   - a manifest that is absent or does not verify: state corpus_unreadable, every class any loaded case names
 *     is held (fail closed), and a runner-failed gap is filed;
 *   - no ever-green set (an ungated node, or before the first publish): every red case is a flip except one
 *     recorded red at append (fail closed, stated in the status);
 *   - a hold past review_by escalates its gap; it is never silently dropped.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, failClosedHolds, fidelityCounts, holdsFrom, loadCorpus, replayCase, type CorpusCase, type Hold } from "./corpus-runner";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { shapedPolicyPath } from "../shaped-policy-store";
import { DEFAULT_PERIOD_S, STATUS_SHAPE, type VerdictCorpusStatus } from "./credit-hold";

export interface CorpusGap {
  id: string;
  severity: "high" | "normal";
  category: string;
  summary: string;
  edit_site: string | null;
  falsifier: { kind: "test"; vessel: string; command: string } | null;
  case_id: string | null;
  credit_class: string | null;
}

export interface CorpusSinks {
  readPreviousStatus(): Promise<Record<string, unknown> | null>;
  readEverGreen(): Promise<string[] | null>;
  writeStatus(s: VerdictCorpusStatus): Promise<void>;
  recordReport(report: VerdictCorpusReport): Promise<void>;
  fileGap(g: CorpusGap): Promise<void>;
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

const falsifierFor = (id: string) => ({ kind: "test" as const, vessel: "goal-host-vessel", command: `bun test test/verdict-corpus/corpus.test.ts -t '${id}'` });

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
  try {
    const lc = loadCorpus(o.dir);
    if (!lc.ok) {
      const status: VerdictCorpusStatus = { ...base, corpus: lc.head, fidelity: fidelityCounts(lc.cases), ever_green: "absent (fail closed)", state: "corpus_unreadable", green: [], flips: [], known_red: [], entry_missing: [], holds: failClosedHolds(lc.cases, nowIso) };
      console.warn(`[verdict-corpus] CORPUS UNREADABLE node=${o.node} — every named class held (fail closed): ${lc.errors.slice(0, 3).join("; ")}`);
      await o.sinks.writeStatus(status);
      await o.sinks.recordReport({ shape: "verdictCorpusReport", trigger: o.trigger, status, red: [], ms: performance.now() - t0 });
      await o.sinks.fileGap({ id: `verdict-corpus-runner-failed-${o.node}`, severity: "high", category: "judge_regression", summary: `The verdict corpus on ${o.node} is unreadable (${lc.errors.slice(0, 3).join("; ")}); every credit class a case names is held until a run verifies it.`, edit_site: "repos/goal-host-vessel/src/judge/corpus-runner.ts", falsifier: { kind: "test", vessel: "goal-host-vessel", command: "bun test test/verdict-corpus/chain.test.ts" }, case_id: null, credit_class: null });
      return status;
    }
    let everGreenList: string[] | null = null;
    try { everGreenList = await o.sinks.readEverGreen(); } catch { everGreenList = null; }
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
      await o.sinks.fileGap({ id: `verdict-corpus-flip-${id}`, severity: "high", category: "judge_regression", summary: `The judge regressed: verdict-corpus case ${id} (class ${c.class}) was green and is red at the live judge. Its credit class ${c.credit_class} is held until the case is green again.`, edit_site: c.edit_site, falsifier: falsifierFor(id), case_id: id, credit_class: c.credit_class });
    }
    for (const id of [...cl.known_red, ...cl.entry_missing]) {
      const c = byId.get(id)!;
      const late = overdue.has(id);
      await o.sinks.fileGap({ id: `verdict-corpus-red-${id}`, severity: late ? "high" : "normal", category: "judge_regression", summary: `Verdict-corpus case ${id} (class ${c.class}) is red at the live judge${late ? ", and its credit hold is past its review date" : ""}. Its credit class ${c.credit_class} is held until the case is green.`, edit_site: c.edit_site, falsifier: falsifierFor(id), case_id: id, credit_class: c.credit_class });
    }
    console.log(`[verdict-corpus] run node=${o.node} trigger=${o.trigger} cases=${lc.cases.length} green=${cl.green.length} flips=${cl.flips.length} known_red=${cl.known_red.length} entry_missing=${cl.entry_missing.length} holds=${holds.length} ever_green=${status.ever_green} fidelity=${JSON.stringify(status.fidelity)}`);
    return status;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.warn(`[verdict-corpus] RUNNER FAILED node=${o.node}: ${msg}`);
    const status: VerdictCorpusStatus = { ...base, corpus: { n: 0, link: "0".repeat(64) }, fidelity: {}, ever_green: "absent (fail closed)", state: "runner_failed", green: [], flips: [], known_red: [], entry_missing: [], holds: prevHolds };
    try { await o.sinks.writeStatus(status); } catch { /* the stale status keeps its holds */ }
    try { await o.sinks.fileGap({ id: `verdict-corpus-runner-failed-${o.node}`, severity: "high", category: "judge_regression", summary: `The verdict corpus runner failed on ${o.node}: ${msg.slice(0, 300)}. The last holds are kept.`, edit_site: "repos/goal-host-vessel/src/judge/corpus-activity.ts", falsifier: null, case_id: null, credit_class: null }); } catch { /* logged above */ }
    return status;
  }
}

// ── the file sinks (the shaped status record and the gate's published ever-green set) ─────────────────

/** The workspace root, as the shaped-policy store resolves it (no environment read of its own). */
export function workspaceRoot(): string { return dirname(dirname(shapedPolicyPath(STATUS_SHAPE))); }
export const everGreenPath = (vessel = "goal-host-vessel"): string => join(workspaceRoot(), ".gate-public", `verdict-corpus-green.${vessel}.json`);

/** The gate's published ever-green ids, or null when none is published (fail closed downstream). */
export async function readEverGreenFile(path = everGreenPath()): Promise<string[] | null> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    const ids = Array.isArray(v) ? v : (v as { ever_green?: unknown })?.ever_green;
    return Array.isArray(ids) && ids.every((x) => typeof x === "string") ? (ids as string[]) : null;
  } catch { return null; }
}

/** Write the status record where resolveShapedPolicy reads it, atomically (tmp + rename). */
export async function writeStatusFile(s: VerdictCorpusStatus, path = shapedPolicyPath(STATUS_SHAPE)): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2) + "\n");
  await rename(tmp, path);
}
