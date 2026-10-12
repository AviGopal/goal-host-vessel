/**
 * THE VERDICT CORPUS RUNNER (closed). ONE copy of the corpus logic: the chain check, the replay of each
 * case through the judge entries production calls, the compare, the classification, and the credit holds
 * a red case puts on its credit class. The protected tests, the CLI and the live runner activity all use
 * this module, so they cannot drift apart.
 *
 * A case is a recorded judge input (src/judge/records.ts) with an expected verdict. The corpus is
 * append-only (MANIFEST.jsonl is a hash chain over the canonical bytes of each case file).
 *
 * Determinism guards (hermetic replay): in-process, no index.ts import; fetch throws during a replay; each
 * case runs twice under different clocks and random sources and must give the same observation; a case
 * that takes more than CASE_WALL_CAP_MS is red. A runtime the runner cannot judge FAILS, it never skips.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as judge from "./entries";
import { zeroToolWriteClaim } from "./floor-clamps";
import { isCreditClass, type CreditClass } from "./classes";
import { creditClassesOf } from "./credit-classes";
export { creditClassesOf };
import { shortcutInput } from "./inputs";
import type { CreditOnHollowInput, FloorShortcutInput, FloorVerdictInput, JudgeInput, ReachGateInput, RecordedJudgeVerdict, ReframeAcceptInput, CompletionShapesInput } from "./records";

export const ENTRIES = ["reachGate", "floorVerdict", "floorShortcut", "reframeAccept", "completionShapes", "creditOnHollow"] as const;
export type EntryName = (typeof ENTRIES)[number];
export const CASE_WALL_CAP_MS = 2000;
export const GENESIS_LINK = "0".repeat(64);
const FLOOR_ID = "universal-tool-fallback";

// ── canonical bytes and the hash chain ───────────────────────────────────────────────────────────────

function sortDeep(v: unknown, path: string): unknown {
  if (v === undefined) throw new Error(`canonical JSON: undefined at ${path}`);
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`canonical JSON: non-finite number at ${path}`);
  if (Array.isArray(v)) return v.map((x, i) => sortDeep(x, `${path}[${i}]`));
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortDeep((v as Record<string, unknown>)[k], `${path}.${k}`);
    return o;
  }
  return v;
}
/** UTF-8, LF, keys sorted recursively, 2-space indent, a trailing newline; no NaN/undefined. */
export function canonicalJson(v: unknown): string { return JSON.stringify(sortDeep(v, "$"), null, 2) + "\n"; }
export const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
export function chainLink(prev: string, n: number, id: string, caseSha: string): string { return sha256Hex(`${prev}\n${n}\n${id}\n${caseSha}`); }

export const FIDELITIES = ["recorded-input", "harness-recorded", "paraphrase-only"] as const;
export type Fidelity = (typeof FIDELITIES)[number];
/** One manifest line. `fidelity` repeats the case's provenance.fidelity (it is covered by case_sha256) so the
 *  chain itself states how close each case is to a recorded judge input. */
export interface ManifestLine { n: number; id: string; path: string; case_sha256: string; fidelity: Fidelity; prev: string; link: string }

export type CaseStatusAtAppend = "green" | "known_red" | "entry_missing";

export interface Expectation {
  reached?: boolean | null;
  hollow_class?: string | null;
  deterministic?: boolean;
  /** reachGate only: "hollow" = the gate hollows it; "pass" = the gate passes it to the later layers. */
  gate?: "hollow" | "pass";
  completion_shapes?: string[];
  shortcut?: "allowed" | "refused";
  credit?: "charged" | "withheld";
  retire_candidate?: boolean;
}

export interface CorpusCase {
  schema: 1;
  id: string;
  class: string;
  entry: string;
  credit_class: string;
  edit_site: string;
  provenance: {
    source: string; recorded: string; note: string;
    /** recorded-input: replays an actual captured judge input (trace_ref names it); harness-recorded: the entry's
     *  actual arguments at a hermetic harness call; paraphrase-only: reconstructed from journal or diagnosis text,
     *  or carrying paraphrased text. */
    fidelity: Fidelity;
    /** The captured input this case replays: an execution id and the input's sha256 (recorded-input only). */
    trace_ref: { execution_id: string; input_digest: string } | null;
  };
  input: JudgeInput;
  llm: { judge: RecordedJudgeVerdict & { completion_shapes?: string[] } } | null;
  ports: Record<string, unknown>;
  expect: Expectation;
  status_at_append: CaseStatusAtAppend;
  control: boolean;
  licenses: { credit_class: string; direction: "reach" } | null;
}

const CASE_KEYS = ["schema", "id", "class", "entry", "credit_class", "edit_site", "provenance", "input", "llm", "ports", "expect", "status_at_append", "control", "licenses"].sort();

export interface LoadedCorpus {
  ok: boolean;
  errors: string[];
  lines: ManifestLine[];
  cases: CorpusCase[];
  head: { n: number; link: string };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string): void => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) rec(p); else out.push(p);
    }
  };
  if (existsSync(dir)) rec(dir);
  return out;
}

/** Load and verify the corpus at `dir` (the directory holding MANIFEST.jsonl and cases/). Never throws. */
export function loadCorpus(dir: string): LoadedCorpus {
  const errors: string[] = [];
  const lines: ManifestLine[] = [];
  const cases: CorpusCase[] = [];
  const manifestPath = join(dir, "MANIFEST.jsonl");
  let raw = "";
  try { raw = readFileSync(manifestPath, "utf8"); } catch { errors.push("MANIFEST.jsonl is absent or unreadable"); }
  if (raw && !raw.endsWith("\n")) errors.push("MANIFEST.jsonl does not end with a newline");
  const rows = raw.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
  let prev = GENESIS_LINK;
  rows.forEach((row, i) => {
    let m: ManifestLine;
    try { m = JSON.parse(row) as ManifestLine; } catch { errors.push(`manifest line ${i + 1} is not JSON`); return; }
    const keys = Object.keys(m).sort().join(",");
    if (keys !== "case_sha256,fidelity,id,link,n,path,prev") errors.push(`manifest line ${i + 1} keys [${keys}]`);
    if (row !== JSON.stringify({ n: m.n, id: m.id, path: m.path, case_sha256: m.case_sha256, fidelity: m.fidelity, prev: m.prev, link: m.link })) errors.push(`manifest line ${i + 1} is not in canonical form`);
    if (!(FIDELITIES as readonly string[]).includes(m.fidelity)) errors.push(`manifest line ${i + 1} fidelity ${JSON.stringify(m.fidelity)} is not one of ${FIDELITIES.join("/")}`);
    if (m.n !== i + 1) errors.push(`manifest line ${i + 1} has n=${m.n} (lines must be contiguous from 1)`);
    if (m.prev !== prev) errors.push(`manifest line ${i + 1} prev does not link to line ${i}`);
    const want = chainLink(m.prev, m.n, m.id, m.case_sha256);
    if (m.link !== want) errors.push(`manifest line ${i + 1} link does not recompute`);
    prev = m.link;
    lines.push(m);
    const p = join(dir, m.path);
    if (!m.path.startsWith("cases/") || m.path.includes("..")) { errors.push(`manifest line ${i + 1} path ${m.path} is outside cases/`); return; }
    let bytes = "";
    try { bytes = readFileSync(p, "utf8"); } catch { errors.push(`listed case ${m.path} is missing`); return; }
    if (sha256Hex(bytes) !== m.case_sha256) errors.push(`case ${m.path} sha256 does not match the manifest`);
    let c: CorpusCase;
    try { c = JSON.parse(bytes) as CorpusCase; } catch { errors.push(`case ${m.path} is not JSON`); return; }
    try { if (canonicalJson(c) !== bytes) errors.push(`case ${m.path} is not in canonical bytes`); } catch (e) { errors.push(`case ${m.path}: ${(e as Error).message}`); }
    if (Object.keys(c).sort().join(",") !== CASE_KEYS.join(",")) errors.push(`case ${m.path} keys are not the case schema`);
    if (c.schema !== 1) errors.push(`case ${m.path} has unknown schema ${c.schema}`);
    if (c.provenance?.fidelity !== m.fidelity) errors.push(`case ${c.id} fidelity ${JSON.stringify(c.provenance?.fidelity)} is not the manifest's ${m.fidelity}`);
    if (c.provenance?.fidelity === "recorded-input" ? !(c.provenance.trace_ref && /^[0-9a-f]{64}$/.test(c.provenance.trace_ref.input_digest) && c.provenance.trace_ref.execution_id) : c.provenance?.trace_ref !== null) errors.push(`case ${c.id}: a recorded-input case names its trace (execution id + input sha256); any other has trace_ref null`);
    if (c.id !== m.id) errors.push(`case ${m.path} id ${c.id} is not the manifest id ${m.id}`);
    if (!/^\d{4}-[a-z0-9-]+$/.test(c.id) || Number(c.id.slice(0, 4)) !== m.n) errors.push(`case id ${c.id} is not <NNNN>-<slug> with NNNN = n`);
    if (m.path !== `cases/${c.class}/${c.id}.json`) errors.push(`case ${c.id} path ${m.path} is not cases/<class>/<id>.json`);
    if (!["green", "known_red", "entry_missing"].includes(c.status_at_append)) errors.push(`case ${c.id} status_at_append ${c.status_at_append}`);
    if (!isCreditClass(c.credit_class)) errors.push(`case ${c.id} credit_class ${c.credit_class} is not a closed credit class`);
    cases.push(c);
  });
  const ids = lines.map((l) => l.id);
  if (new Set(ids).size !== ids.length) errors.push("a case id is listed more than once");
  const listed = new Set(lines.map((l) => l.path));
  for (const f of listFiles(join(dir, "cases"))) {
    const rel = relative(dir, f);
    if (!listed.has(rel)) errors.push(`case file ${rel} is not listed in the manifest`);
  }
  if (lines.length === 0) errors.push("the corpus is empty");
  return { ok: errors.length === 0, errors, lines, cases, head: { n: lines.length, link: prev } };
}

/** Cases by fidelity (the runner report and the CLI show this). */
export function fidelityCounts(cases: CorpusCase[]): Record<Fidelity, number> {
  const out = { "recorded-input": 0, "harness-recorded": 0, "paraphrase-only": 0 } as Record<Fidelity, number>;
  for (const c of cases) if ((FIDELITIES as readonly string[]).includes(c.provenance?.fidelity)) out[c.provenance.fidelity]++;
  return out;
}

// ── replay ───────────────────────────────────────────────────────────────────────────────────────────

export interface Observation {
  reached?: boolean | null;
  hollow_class?: string | null;
  deterministic?: boolean;
  gate?: "hollow" | "pass";
  completion_shapes?: string[];
  shortcut?: "allowed" | "refused";
  credit?: "charged" | "withheld";
  retire_candidate?: boolean;
}

/** Test seams for the must-fails: a different open-rules module, the F-a clamp turned off, a different credit decision. */
export interface ReplayOverrides {
  rules?: Parameters<typeof judge.withRules>[0];
  zeroToolClaimOff?: boolean;
  credit?: (i: CreditOnHollowInput) => ReturnType<typeof judge.creditOnHollow>;
}

export class UnrecordedPort extends Error {}

const upstreamOf = (c: CorpusCase): (RecordedJudgeVerdict & { completion_shapes?: string[] }) | null => {
  const oracle = c.ports?.["citation_oracle"] as (RecordedJudgeVerdict & { completion_shapes?: string[] }) | undefined;
  return oracle ?? c.llm?.judge ?? null;
};

function observeReachGate(c: CorpusCase, input: ReachGateInput): Observation {
  const g = judge.reachGate(input);
  if (g.hollow) return { gate: "hollow", reached: false, hollow_class: g.hollow_class, deterministic: g.deterministic };
  const up = upstreamOf(c);
  return { gate: "pass", reached: up ? (up.reached === true && up.abstain !== true) : null, hollow_class: null, deterministic: false };
}

/** The floor's verdict, composed exactly as production composes it: the reach gate, then the upstream
 *  verdict (recorded), then the closed F-a clamp, then the floor's own decision; completion shapes only on
 *  a reach; and the borrowed-floor shortcut for the same goal and targets. */
function observeFloor(c: CorpusCase, input: FloorVerdictInput, o: ReplayOverrides): Observation {
  const gate = judge.reachGate({ ...input, entry: "reachGate" } as unknown as ReachGateInput);
  let upstream: (RecordedJudgeVerdict & { completion_shapes?: string[] }) | null;
  let hollowClass: string | null = null;
  let deterministic = false;
  if (gate.hollow) { upstream = { reached: false, reason: gate.reason ?? "" }; hollowClass = gate.hollow_class; deterministic = gate.deterministic; }
  else upstream = upstreamOf(c);
  const ev = input.evidence;
  if (!o.zeroToolClaimOff && upstream?.reached === true && zeroToolWriteClaim([input.answer_text, upstream.reason], { toolsTotal: ev.tools_total, writes: ev.persisted_writes.length })) {
    upstream = { reached: false, reason: "deterministic:zero-tool-write-claim" };
    hollowClass = "zero-tool-write-claim";
  }
  const fv = judge.floorVerdict(input, upstream ? { reached: upstream.reached === true, reason: upstream.reason, abstain: upstream.abstain === true } : null);
  if (!fv.reached && hollowClass === null) hollowClass = fv.hollow_class;
  const completion = fv.reached ? judge.completionShapes({ schema: 1, entry: "completionShapes", judge_named: upstream?.completion_shapes ?? [], produced: ev.persisted_writes }) : [];
  const sc = judge.floorShortcut(shortcutInput({ goal: input.goal, activities: [FLOOR_ID], borrowed: true, targets: input.targets_seen_by_walk }));
  return { reached: fv.reached, hollow_class: fv.reached ? null : hollowClass, deterministic: fv.reached ? false : deterministic, completion_shapes: completion, shortcut: sc.allowed ? "allowed" : "refused" };
}

/** What the entry observes for this case (one run). */
export function observe(c: CorpusCase, o: ReplayOverrides = {}): Observation | "entry_missing" {
  if (!(ENTRIES as readonly string[]).includes(c.entry) || (c.input as { entry?: string })?.entry !== c.entry) return "entry_missing";
  const run = (): Observation => {
    switch (c.entry as EntryName) {
      case "reachGate": return observeReachGate(c, c.input as ReachGateInput);
      case "floorVerdict": return observeFloor(c, c.input as FloorVerdictInput, o);
      case "floorShortcut": { const r = judge.floorShortcut(c.input as FloorShortcutInput); return { shortcut: r.allowed ? "allowed" : "refused" }; }
      case "reframeAccept": { const r = judge.reframeAccept(c.input as ReframeAcceptInput); return { reached: r.accept }; }
      case "completionShapes": return { completion_shapes: judge.completionShapes(c.input as CompletionShapesInput) };
      case "creditOnHollow": { const d = (o.credit ?? judge.creditOnHollow)(c.input as CreditOnHollowInput); return { credit: d.charge ? "charged" : "withheld", retire_candidate: d.retire_candidate }; }
    }
  };
  return judge.replaying(() => (o.rules !== undefined ? judge.withRules(o.rules, run) : run()));
}

/** Only the keys `expect` names are compared; each must equal exactly. */
export function compare(expect: Expectation, obs: Observation): string[] {
  const diffs: string[] = [];
  for (const k of Object.keys(expect) as (keyof Expectation)[]) {
    const want = canonicalJson(expect[k] ?? null);
    const got = canonicalJson((obs as Record<string, unknown>)[k] ?? null);
    if (want !== got) diffs.push(`${k}: expected ${want.trim()} observed ${got.trim()}`);
  }
  return diffs;
}

export type CaseOutcome = "green" | "red" | "entry_missing" | "nondeterministic" | "timeout" | "error";
export interface CaseResult { id: string; outcome: CaseOutcome; diffs: string[]; observed: Observation | null; ms: number }

const CLOCKS: Array<{ now: number; rand: number }> = [{ now: 1_000_000_000_000, rand: 0.25 }, { now: 2_000_000_000_000, rand: 0.75 }];

/** Replay one case under the determinism guards. */
export function replayCase(c: CorpusCase, o: ReplayOverrides = {}): CaseResult {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const realRandom = Math.random;
  const t0 = performance.now();
  const runs: Array<Observation | "entry_missing"> = [];
  try {
    (globalThis as { fetch: unknown }).fetch = () => { throw new Error("verdict corpus replay: fetch is not allowed"); };
    for (const k of CLOCKS) {
      Date.now = () => k.now;
      Math.random = () => k.rand;
      runs.push(observe(c, o));
    }
  } catch (e) {
    return { id: c.id, outcome: "error", diffs: [`${e instanceof UnrecordedPort ? "UnrecordedPort" : "threw"}: ${(e as Error)?.message ?? String(e)}`], observed: null, ms: performance.now() - t0 };
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    Date.now = realNow;
    Math.random = realRandom;
  }
  const ms = performance.now() - t0;
  if (runs[0] === "entry_missing") return { id: c.id, outcome: "entry_missing", diffs: [`entry ${c.entry} does not exist`], observed: null, ms };
  const [a, b] = runs as Observation[];
  if (canonicalJson(a) !== canonicalJson(b)) return { id: c.id, outcome: "nondeterministic", diffs: [`two runs differ: ${canonicalJson(a).trim()} vs ${canonicalJson(b).trim()}`], observed: a, ms };
  if (ms > CASE_WALL_CAP_MS * CLOCKS.length) return { id: c.id, outcome: "timeout", diffs: [`took ${Math.round(ms)} ms (cap ${CASE_WALL_CAP_MS} ms per run)`], observed: a, ms };
  const diffs = compare(c.expect, a);
  return { id: c.id, outcome: diffs.length === 0 ? "green" : "red", diffs, observed: a, ms };
}

// ── classification and credit holds ──────────────────────────────────────────────────────────────────

export type HoldDirection = "reach" | "hollow";
/** A red case that expects hollow (the judge says reached) holds REACH-direction credit for its class; a
 *  red control (expects reached/allowed) holds HOLLOW-direction credit. */
export function holdDirection(c: CorpusCase): HoldDirection {
  const e = c.expect;
  if (e.reached === false || e.shortcut === "refused" || e.gate === "hollow" || e.credit === "charged") return "reach";
  return "hollow";
}

export interface Hold { credit_class: string; direction: HoldDirection; case_ids: string[]; since: string; review_by: string }
export const REVIEW_AFTER_MS = 72 * 3600 * 1000;

export interface Classified { green: string[]; flips: string[]; known_red: string[]; entry_missing: string[]; nondeterministic: string[] }

/**
 * Classify each result against the ever-green set the gate publishes. With no ever-green set (an ungated
 * node, or before the first publish) fail closed: every red case is a flip, except a case recorded red at
 * append (status_at_append known_red / entry_missing).
 */
export function classify(cases: CorpusCase[], results: CaseResult[], everGreen: Set<string> | null): Classified {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const out: Classified = { green: [], flips: [], known_red: [], entry_missing: [], nondeterministic: [] };
  for (const r of results) {
    const c = byId.get(r.id)!;
    if (r.outcome === "green") { out.green.push(r.id); continue; }
    if (r.outcome === "nondeterministic") out.nondeterministic.push(r.id);
    const everWasGreen = everGreen ? everGreen.has(r.id) : c.status_at_append === "green";
    if (everWasGreen) out.flips.push(r.id);
    else if (r.outcome === "entry_missing") out.entry_missing.push(r.id);
    else out.known_red.push(r.id);
  }
  return out;
}

/** The holds a classification implies, carrying `since` from the previous status where the hold persists. */
export function holdsFrom(cases: CorpusCase[], cl: Classified, nowIso: string, previous: Hold[] = []): Hold[] {
  const red = new Set([...cl.flips, ...cl.known_red, ...cl.entry_missing]);
  const m = new Map<string, Hold>();
  for (const c of cases) {
    if (!red.has(c.id)) continue;
    const dir = holdDirection(c);
    const key = `${c.credit_class}|${dir}`;
    const h = m.get(key) ?? { credit_class: c.credit_class, direction: dir, case_ids: [], since: nowIso, review_by: "" };
    h.case_ids.push(c.id);
    m.set(key, h);
  }
  for (const h of m.values()) {
    const prev = previous.find((p) => p.credit_class === h.credit_class && p.direction === h.direction);
    if (prev?.since) h.since = prev.since;
    h.review_by = new Date(Date.parse(h.since) + REVIEW_AFTER_MS).toISOString();
  }
  return [...m.values()].sort((a, b) => `${a.credit_class}|${a.direction}`.localeCompare(`${b.credit_class}|${b.direction}`));
}

/** The fail-closed holds when no status exists: every class any case names, in its case's direction. */
export function failClosedHolds(cases: CorpusCase[], nowIso: string): Hold[] {
  return holdsFrom(cases, { green: [], flips: cases.map((c) => c.id), known_red: [], entry_missing: [], nondeterministic: [] }, nowIso);
}

// ── a whole run ──────────────────────────────────────────────────────────────────────────────────────

export interface CorpusRun {
  corpus: { n: number; link: string };
  fidelity: Record<Fidelity, number>;
  chain_ok: boolean;
  chain_errors: string[];
  results: CaseResult[];
  classified: Classified;
}

export function runCorpus(dir: string, opts: { everGreen?: Set<string> | null; overrides?: ReplayOverrides } = {}): CorpusRun {
  const lc = loadCorpus(dir);
  const results = lc.cases.map((c) => replayCase(c, opts.overrides));
  return { corpus: lc.head, fidelity: fidelityCounts(lc.cases), chain_ok: lc.ok, chain_errors: lc.errors, results, classified: classify(lc.cases, results, opts.everGreen === undefined ? null : opts.everGreen) };
}

/** append-check: every case from manifest index `fromN` on must observe exactly its status_at_append. */
export function appendCheck(dir: string, fromN: number, overrides?: ReplayOverrides): { ok: boolean; mismatches: string[] } {
  const lc = loadCorpus(dir);
  const mismatches: string[] = lc.ok ? [] : lc.errors.map((e) => `chain: ${e}`);
  for (const c of lc.cases) {
    if (Number(c.id.slice(0, 4)) < fromN) continue;
    const r = replayCase(c, overrides);
    const observed: CaseStatusAtAppend = r.outcome === "green" ? "green" : r.outcome === "entry_missing" ? "entry_missing" : "known_red";
    if (r.outcome === "nondeterministic" || r.outcome === "timeout" || r.outcome === "error") mismatches.push(`${c.id}: ${r.outcome} (${r.diffs.join("; ")})`);
    else if (observed !== c.status_at_append) mismatches.push(`${c.id}: appended as ${c.status_at_append}, observed ${observed}${r.diffs.length ? ` (${r.diffs.join("; ")})` : ""}`);
    if (!creditClassesOf(c.input, upstreamOf(c)?.reason ?? null).includes(c.credit_class as CreditClass)) mismatches.push(`${c.id}: credit_class ${c.credit_class} is not among the classes its input computes [${creditClassesOf(c.input, upstreamOf(c)?.reason ?? null).join(", ")}]`);
  }
  return { ok: mismatches.length === 0, mismatches };
}
