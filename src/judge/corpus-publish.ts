/**
 * THE CORPUS RUNNER'S OWN IDENTITY (closed).
 *
 * The verdictCorpusStatus row is the credit stop's input, and development-vessel admits a write of it only from a
 * credential carrying the `verdict-corpus:write` scope (pool-impulse.ts, the runner grant). goal-host's process-wide
 * key goes out on every walk egress, so it must not be the credential that grant admits: the corpus runner
 * publishes under its OWN principal, `goal-host-corpus-runner`, whose key carries that scope and nothing else.
 *
 *   - The key is read from GOAL_HOST_CORPUS_RUNNER_API_KEY HERE, inside the publish, at use time (a secret,
 *     bootstrap-only per law 1; never cached, never returned, never exported). Nothing else in goal-host reads it,
 *     and the walk has no edge to this module (test/corpus-runner-identity.test.ts pins both).
 *   - Empty or absent means not provisioned: the publish throws before any request, and never falls back to the
 *     process-wide key. The runner then reports itself failed and the credit stop keeps its last verified record
 *     (the existing hold path).
 *   - A refusal by development-vessel throws as before, so the runner never believes a status it could not publish.
 */
import { STATUS_ID, STATUS_SHAPE, STATUS_SOURCE, type VerdictCorpusStatus } from "./credit-hold";

/** The runner's principal and its one scope, as identity mints them (named here for the record and the spec). */
export const CORPUS_RUNNER_PRINCIPAL = "goal-host-corpus-runner";
export const CORPUS_RUNNER_SCOPES: readonly string[] = ["verdict-corpus:write"];
export const CORPUS_RUNNER_KEY_MISSING = "corpus runner key not provisioned";

export interface CorpusPublishDeps {
  /** development-vessel's base URL (the pool store that serves the runner grant). */
  devVesselEndpoint: string;
  /** Re-read the status from the pool after a confirmed write (credit-hold refreshStatusFromPool). */
  refresh: () => Promise<{ ok: boolean; why?: string }>;
}

/** Publish one corpus status under the runner's own credential. Throws when it cannot (key absent, refused, unconfirmed). */
export async function publishVerdictCorpusStatusAsRunner(st: VerdictCorpusStatus, deps: CorpusPublishDeps): Promise<void> {
  const runnerKey = process.env.GOAL_HOST_CORPUS_RUNNER_API_KEY ?? "";
  if (runnerKey.trim().length === 0) {
    console.error(`[verdict-corpus] STATUS NOT PUBLISHED: ${CORPUS_RUNNER_KEY_MISSING} (principal ${CORPUS_RUNNER_PRINCIPAL}); the credit stop keeps reading the last verified record`);
    throw new Error(`verdictCorpusStatus not published: ${CORPUS_RUNNER_KEY_MISSING}`);
  }
  const r = await fetch(`${deps.devVesselEndpoint}/v2/impulses/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${runnerKey.trim()}` },
    body: JSON.stringify({ impulse: { type: "poolImpulse_write", pointer: { type: "poolImpulse_write", id: STATUS_ID, shape: STATUS_SHAPE, source: STATUS_SOURCE, status: "open", body: st } } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    let err = ""; try { err = String(((await r.json()) as { error?: unknown }).error ?? "").slice(0, 300); } catch { /* no body */ }
    console.error(`[verdict-corpus] STATUS NOT PUBLISHED: development-vessel answered HTTP ${r.status}${err ? ` (${err})` : ""}; the credit stop keeps reading the last verified record`);
    throw new Error(`verdictCorpusStatus not published: HTTP ${r.status}${err ? ` ${err}` : ""}`);
  }
  let ok = false; try { ok = ((await r.json()) as { body?: { ok?: unknown } }).body?.ok === true; } catch { ok = false; }
  if (!ok) throw new Error("verdictCorpusStatus not published: development-vessel did not confirm the write");
  const refreshed = await deps.refresh();
  if (!refreshed.ok) console.warn(`[verdict-corpus] status published but not read back verified: ${refreshed.why}`);
}
