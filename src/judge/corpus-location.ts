/**
 * WHERE THE VERDICT CORPUS IS READ AT RUNTIME (closed; the one resolver every corpus reader uses).
 *
 * The corpus lives in the vessel repo at test/verdict-corpus/. A running node's deployed tree (/vessels/goal-host-vessel)
 * is built by mirror-to-live, which copies src/, sql/, scripts/, git-tracked dist/ dirs, tsconfig.json and index.ts, and
 * never test/. Resolving the corpus relative to this module (src/judge/../../test/verdict-corpus) therefore named a
 * directory that exists in every clone and test gate but in no running node: the runner read an empty corpus, published
 * nothing, and the credit hold held nothing, while every gate passed (the gate runs in the clone).
 *
 * The corpus is read from the vessel's own clone instead: <clone root>/goal-host-vessel/test/verdict-corpus, where the
 * clone root is VESSELS_CLONE_ROOT (bootstrap location, as escalation-target.ts reads it) or /workspace/git/vessels.
 * pull-sync fast-forwards that clone to the gate-accepted commit, and the corpus is append-only (MANIFEST hash chain),
 * so the clone's copy is the deployed corpus or its next accepted extension.
 *
 * FAIL CLOSED: there is no fallback to the deployed mirror or to a module-relative path. A missing clone directory reads
 * as an unreadable corpus (loadCorpus reports "MANIFEST.jsonl is absent or unreadable"), exactly as before.
 */
import { join } from "node:path";

export const GOAL_HOST_VESSEL = "goal-host-vessel";
export const DEFAULT_CLONE_ROOT = "/workspace/git/vessels";
export const CORPUS_REL = join("test", "verdict-corpus");

/** The clone root: an absolute VESSELS_CLONE_ROOT, else the fleet default. */
export function cloneRoot(env: Record<string, string | undefined> = process.env): string {
  const r = (env["VESSELS_CLONE_ROOT"] ?? "").trim();
  return r.startsWith("/") ? r : DEFAULT_CLONE_ROOT;
}

/** The verdict corpus directory every runtime reader uses (never a path relative to the deployed module). */
export function verdictCorpusDir(env: Record<string, string | undefined> = process.env): string {
  return join(cloneRoot(env), GOAL_HOST_VESSEL, CORPUS_REL);
}
