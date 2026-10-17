/**
 * JUDGE CONSISTENCY: THE SAME ANSWER TO THE SAME GOAL GETS THE SAME VERDICT (REALIGNMENT judge-consistency item; qa scope
 * pin 2026-10-17 ~07:5xZ, design and storage approved ~11:5xZ).
 *
 * The LLM reach judge is stochastic: one answer, judged twice under two attempt contexts, could be reached once and
 * hollow once, and each verdict was taken as truth (α or β, a gap, a retry). Here every NON-deterministic verdict of the
 * reach gate is keyed by (goal_hash, answer digest) and checked against the verdict this node gave the same key before:
 *   - first sight: recorded;
 *   - the same verdict again: agreement, counted;
 *   - a DIFFERENT verdict: the judge disagrees with itself. k samples are drawn (the existing consensusSymbols
 *     majority, goal-file-resolution.ts) and the MAJORITY is the verdict, for this call and every later call on the
 *     key. A tie resolves to not-reached (fail toward honest: a reach the judge cannot reproduce is not a reach).
 *     The disagreement is RECORDED by this module as a case file beside the store (the prior, current and sampled
 *     verdicts; never into the sealed, hash-chained verdict corpus, where promotion stays a reviewed act) and filed as a gap
 *     SEED through discovery (source substrate_detected), so the system, not an operator, owns the follow-up.
 *
 * KEY. goal_hash is goalHashOf (text-keyed). The digest is computed at verdict time from the answer under judgment
 * (the content digest, else the task summary) plus the produced shapes, after normalisation that removes what is NOT
 * the answer (case, whitespace, markdown emphasis and structure marks, ISO timestamps, uuids, dispatch/exec/trace ids, 13-digit ms
 * stamps). The capture record is not changed (test/judge-capture/schema.test.ts pins its exact key set).
 *
 * STORE. One file per key: <root>/state/verdict-consistency/<goal_hash>/<digest>.json, so a lookup is ONE keyed read
 * whatever the number of stored keys. The root is set only by the service boot (setVerdictConsistencyRoot); with no
 * root nothing is read or written, and the test seam refuses a non-scratch root (the leak-guard class rule: a suite must
 * never write live learned state). /state/ is gitignored.
 * k and the TTL come from ONE shaped tuning row (selection-tuning.ts: verdictConsistencyK, verdictConsistencyTtlMs).
 * Visible to the system: the `verdictConsistency` read shape (goal-host's resolve path) and /health counters.
 *
 * NAMED LIMITS. (a) PER NODE: the store is this node's (data locality: the dispatch runs where the walk ran), so the
 * same answer judged on two nodes is not cross-checked. (b) SAME WORDING ONLY: goal_hash is text-keyed and the digest is
 * surface-normalised, not meaning-keyed; a real paraphrase is a different key (the meaning-keyed-paths gap).
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import { consensusSymbols } from "../goal-file-resolution";

export type ConsistencyVerdict = "reached" | "not_reached";
export interface ConsistencyRecord {
  verdict: ConsistencyVerdict;
  reason_code: string | null;
  n: number;
  first_at: string;
  last_at: string;
  majority?: { verdict: ConsistencyVerdict; k: number; votes: { reached: number; not_reached: number }; at: string };
}
export type ConsistencyOutcome = "first" | "agree" | "held_majority" | "disagree_resolved";

const counters = { lookups: 0, agreements: 0, disagreements: 0, k_resolutions: 0, errors: 0 };
export function consistencyCounters(): Readonly<typeof counters> { return { ...counters }; }
export function resetConsistencyCounters(): void { for (const k of Object.keys(counters) as Array<keyof typeof counters>) counters[k] = 0; }

/** What is NOT the answer is removed before hashing, so two attempt contexts of one answer share a key. */
export function normaliseAnswer(s: string): string {
  return s.normalize("NFKC").toLowerCase()
    .replace(/[*`~]+/g, "")      // emphasis marks are not the answer (underscores stay: identifiers carry them)
    .replace(/[#>|]+/g, " ")     // headings, quotes and table rules separate words
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b(?:exec|dispatch|disp|att|trace|walk)[_-][a-z0-9_-]{4,}\b/g, "<id>")
    .replace(/\b\d{13}\b/g, "<ms>")
    .replace(/\s+/g, " ")
    .trim();
}
/** The answer digest: produced shapes (sorted) + the normalised answer, sha256, 16 hex. */
export function answerDigest(answer: string, producedShapes: readonly string[] = []): string {
  const shapes = [...new Set(producedShapes.map(String))].sort().join(",");
  return createHash("sha256").update(`shapes:${shapes}\n${normaliseAnswer(answer)}`, "utf8").digest("hex").slice(0, 16);
}

const SAFE = /^[0-9a-zA-Z_-]{1,64}$/;
/** A scratch root: under the OS temp dir or /tmp (where every test and the scrubbed suite run). */
export function isScratchRoot(p: string): boolean {
  const r = resolvePath(p), t = resolvePath(tmpdir());
  return r === t || r.startsWith(t + sep) || r.startsWith("/tmp/");
}
/** The store's root. UNSET until goal-host's SERVICE BOOT sets it (index.ts, inside its import.meta.main block, the
 *  path only the running service takes), so an importer that is not the service (a test, a tool) has no store: nothing
 *  is read or written, and no live file can be touched. No env read: the "started as the service" signal is the boot
 *  path goal-host already has (user ruling 2026-10-17T12:19:01Z). */
let storeRoot: string | null = null;
/** Called once by the service boot with the root of the store goal-host already keeps (its dispatch store's directory). */
export function setVerdictConsistencyRoot(root: string): void { storeRoot = root; }
/** Test seam (the style of gapStoreRootForTest): a SCRATCH root for a test, or null to unset. A non-scratch root is
 *  refused, so a test can never point the store at live state. */
export function setVerdictConsistencyRootForTest(root: string | null): void {
  if (root !== null && !isScratchRoot(root)) throw new Error(`verdict-consistency refused: ${root} is not a scratch root`);
  storeRoot = root;
}
/** The store directory, or null when no root is set (nothing is read or written then). */
export function consistencyDir(): string | null {
  return storeRoot ? join(storeRoot, "state", "verdict-consistency") : null;
}
export function recordPath(dir: string, goalHash: string, digest: string): string {
  if (!SAFE.test(goalHash) || !SAFE.test(digest)) throw new Error("verdict-consistency: unsafe key");
  return join(dir, goalHash, `${digest}.json`);
}

export interface ConsistencyStoreIO {
  read(path: string): Promise<string | null>;
  write(path: string, body: string): Promise<void>;
  list(dir: string): Promise<string[]>;
}
export const fsStore: ConsistencyStoreIO = {
  async read(p) { try { return await readFile(p, "utf8"); } catch { return null; } },
  async write(p, body) {
    await mkdir(join(p, ".."), { recursive: true });
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, p);
  },
  async list(d) { try { return (await readdir(d)).filter((n) => n.endsWith(".json")); } catch { return []; } },
};

export interface ReconcileDeps {
  dir: string;
  store: ConsistencyStoreIO;
  now: () => Date;
  /** One more independent judge sample (i = 1..k-1); null when the judge did not answer. */
  sample: (i: number) => Promise<{ reached: boolean; reason?: string } | null>;
  /** Best effort: the disagreement as a replay case, and a gap seed through discovery. Never throws into the gate. */
  recordDisagreement?: (c: DisagreementCase) => Promise<void>;
}
export interface DisagreementCase {
  goal_hash: string; digest: string; goal: string; answer_excerpt: string; produced_shapes: string[];
  prior: ConsistencyRecord; current: { reached: boolean; reason: string | null };
  samples: Array<{ reached: boolean; reason: string | null }>; majority: ConsistencyVerdict; k: number; at: string;
}
const reasonCode = (r: string | null | undefined): string | null => (typeof r === "string" && r.trim() ? r.trim().split(/[\s:—-]/)[0]!.slice(0, 40) : null);
const asV = (reached: boolean): ConsistencyVerdict => (reached ? "reached" : "not_reached");

/**
 * Reconcile one non-deterministic verdict with what this node said before for the same (goal_hash, digest).
 * Returns the verdict to use (the stored majority when the key was already resolved).
 */
export async function reconcileVerdict(
  input: { goalHash: string; digest: string; goal: string; answer: string; producedShapes: readonly string[]; verdict: { reached: boolean; reason?: string | null }; k: number; ttlMs: number },
  deps: ReconcileDeps,
): Promise<{ reached: boolean; reason: string | null; outcome: ConsistencyOutcome }> {
  counters.lookups++;
  const path = recordPath(deps.dir, input.goalHash, input.digest);
  const now = deps.now();
  const cur = asV(input.verdict.reached);
  const reason = input.verdict.reason ?? null;
  let rec: ConsistencyRecord | null = null;
  const raw = await deps.store.read(path);
  if (raw) { try { rec = JSON.parse(raw) as ConsistencyRecord; } catch { rec = null; } }
  if (rec && now.getTime() - Date.parse(rec.last_at) > input.ttlMs) rec = null; // expired: a fresh first sight
  if (!rec) {
    await deps.store.write(path, JSON.stringify({ verdict: cur, reason_code: reasonCode(reason), n: 1, first_at: now.toISOString(), last_at: now.toISOString() } satisfies ConsistencyRecord));
    return { reached: input.verdict.reached, reason, outcome: "first" };
  }
  const settled = rec.majority?.verdict ?? rec.verdict;
  if (settled === cur) {
    counters.agreements++;
    await deps.store.write(path, JSON.stringify({ ...rec, n: rec.n + 1, last_at: now.toISOString() }));
    return { reached: input.verdict.reached, reason, outcome: "agree" };
  }
  counters.disagreements++;
  if (rec.majority) {
    // Already resolved for this exact goal + answer: the majority stands; a lone dissent does not re-open it.
    await deps.store.write(path, JSON.stringify({ ...rec, n: rec.n + 1, last_at: now.toISOString() }));
    return { reached: rec.majority.verdict === "reached", reason: `${reason ?? ""} [verdict-consistency: this goal and answer were resolved ${rec.majority.verdict} by a ${rec.majority.k}-sample majority; a dissenting verdict does not reopen it]`.trim(), outcome: "held_majority" };
  }
  const k = Math.max(1, Math.floor(input.k));
  const samples: Array<{ reached: boolean; reason: string | null }> = [];
  for (let i = 1; i < k; i++) {
    const s = await deps.sample(i).catch(() => null);
    if (s) samples.push({ reached: s.reached, reason: s.reason ?? null });
  }
  const votes = [rec.verdict, cur, ...samples.map((s) => asV(s.reached))];
  // consensusSymbols: most-agreed first; a tie breaks to the longer symbol, i.e. not_reached (fail toward honest).
  const majority = (consensusSymbols(votes.map((v) => [v]))[0] ?? "not_reached") as ConsistencyVerdict;
  const tally = { reached: votes.filter((v) => v === "reached").length, not_reached: votes.filter((v) => v === "not_reached").length };
  counters.k_resolutions++;
  const resolved: ConsistencyRecord = { ...rec, n: rec.n + 1, last_at: now.toISOString(), majority: { verdict: majority, k: votes.length, votes: tally, at: now.toISOString() } };
  await deps.store.write(path, JSON.stringify(resolved));
  if (deps.recordDisagreement) {
    void deps.recordDisagreement({
      goal_hash: input.goalHash, digest: input.digest, goal: input.goal.slice(0, 600), answer_excerpt: input.answer.slice(0, 1200), produced_shapes: [...input.producedShapes],
      prior: rec, current: { reached: input.verdict.reached, reason }, samples, majority, k: votes.length, at: now.toISOString(),
    }).catch(() => { counters.errors++; });
  }
  return { reached: majority === "reached", reason: `${reason ?? ""} [verdict-consistency: the judge disagreed with its own earlier verdict on this goal and answer; ${tally.reached} reached vs ${tally.not_reached} not over ${votes.length} verdicts, majority ${majority}]`.trim(), outcome: "disagree_resolved" };
}

/** The `verdictConsistency` read shape: one key (goal_hash + digest) or every key under a goal_hash (one directory). */
export async function readVerdictConsistency(q: { goal_hash?: unknown; digest?: unknown }, dir: string, store: ConsistencyStoreIO = fsStore): Promise<{ goal_hash: string; records: Array<ConsistencyRecord & { digest: string }> } | { error: string }> {
  const gh = typeof q.goal_hash === "string" ? q.goal_hash : "";
  if (!SAFE.test(gh)) return { error: "goal_hash is required" };
  const digests = typeof q.digest === "string" && q.digest ? [q.digest] : (await store.list(join(dir, gh))).map((n) => n.replace(/\.json$/, ""));
  const records: Array<ConsistencyRecord & { digest: string }> = [];
  for (const d of digests) {
    if (!SAFE.test(d)) continue;
    const raw = await store.read(recordPath(dir, gh, d));
    if (!raw) continue;
    try { records.push({ digest: d, ...(JSON.parse(raw) as ConsistencyRecord) }); } catch { /* unreadable row: skipped */ }
  }
  return { goal_hash: gh, records };
}

/** The disagreement as a replay case beside the store (never into the sealed, hash-chained verdict corpus; promoting
 *  one there stays a reviewed act). */
export function disagreementCasePath(dir: string, c: Pick<DisagreementCase, "goal_hash" | "digest">): string {
  return join(dir, "disagreements", `${c.goal_hash}-${c.digest}.json`);
}
/** The gap SEED the module files (source substrate_detected): the judge disagreed with itself on one goal+answer. */
export function disagreementGapSeed(c: DisagreementCase): Record<string, unknown> {
  return {
    id: `reach-judge-disagreed-with-itself-${c.goal_hash}-${c.digest}`,
    category: "systematic_failure",
    source: "substrate_detected",
    status: "open",
    summary: `The reach judge gave two different verdicts for the same goal and the same answer (goal_hash ${c.goal_hash}, answer digest ${c.digest}): earlier ${c.prior.verdict}, now ${c.current.reached ? "reached" : "not_reached"}. A ${c.k}-verdict majority resolved it ${c.majority}. A judge that cannot reproduce its own verdict cannot grade this goal class reliably; the case is recorded for replay. Goal: ${c.goal.slice(0, 240)}`,
    classification_metadata: { origin: "verdict-consistency", goal_hash: c.goal_hash, digest: c.digest, majority: c.majority, k: c.k, produced_shapes: c.produced_shapes },
  };
}
