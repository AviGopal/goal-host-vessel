/**
 * Serving `lessonExecutionPolicy` — the third shape the walk reads and nobody served.
 *
 * WHY THIS EXISTS (2026-08-16). `lessonVerbatimAllowed()` resolves this shape through discovery
 * at use time and FAILS CLOSED when nothing answers. Nothing has ever answered: a discovery
 * `vesselCapability` lookup returns 0 vessels for `lessonExecutionPolicy` (against 2 each for
 * `memoryNote` and `bodyHonestyPolicy`, so the query is known to show positives). The
 * consequence is that the deterministic verbatim-execution bypass at index.ts — written for a
 * measured failure, complete, and correct — is unreachable in every deployment. The reader
 * shipped without the producer; that was my miss, the same one as `walkBudget`.
 *
 * WHAT IT GATES, stated plainly because the risk is the point. When enabled, and only when the
 * walk is filling an EXECUTOR shape, a single fenced `curl`/`wget` command recalled from a
 * lesson is run AS WRITTEN instead of being re-synthesized by the drafter. That exists because,
 * measured over 45 dispatches of one goal, the drafter handed a verified working command
 * reproduced it correctly ZERO times — freezing timestamps, dropping %27 quoting, substituting
 * hosts, inventing parameters. The information was delivered every time, so this is
 * reproduction fidelity, not missing context, and no further wording addresses it.
 *
 * THE RISK, equally plainly. concept-db is written autonomously and is reachable by any vessel.
 * The substrate already executes LLM-synthesized shell and recalled lessons already steer that
 * synthesis, so concept-db text already reaches the shell — but with a model in between.
 * Executing it directly makes an injected concept DETERMINISTIC rather than persuasion-dependent.
 * That is a real widening of the blast radius, not a formality.
 *
 * SO: SHIPPING THIS PRODUCER MUST NOT ENABLE ANYTHING, and it does not.
 *
 *   - no policy file            → resolve null → consumer's 404 → verbatim stays OFF
 *   - file without the flag     → resolve null → verbatim stays OFF
 *   - `verbatimCommands: false` → resolve null → verbatim stays OFF
 *   - `verbatimCommands: true`  → served → verbatim ON, and every use is logged with the
 *                                 command actually taken
 *
 * Only the last case changes behaviour, and it requires someone to write that file. What this
 * module buys is that the decision becomes a shaped, auditable, revocable fact the fleet can
 * see — revocable by deleting a file, with no restart and no code edit — instead of a constant
 * welded shut behind a reader with no producer. That is the law-1 property; enabling remains a
 * separate act.
 *
 * NO `_write` COMPANION. Anything that could write this could enable deterministic execution of
 * autonomously-authored text, which is exactly the capability the gate exists to withhold.
 * Seeding is an operator/seeder act, deliberately out-of-band.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Mirrors what `lessonVerbatimAllowed()` reads: `body?.verbatimCommands === true`. */
export interface LessonExecutionPolicy {
  verbatimCommands: boolean;
}

/**
 * Same volume convention as bodyHonestyPolicy / walkBudget.
 *
 * ★ WORKSPACE_ROOT IS NOT /workspace — goal-host's unit carries
 * `WORKSPACE_ROOT="/workspace/git/super-repo"`. Seeding under the wrong root produces a
 * perfectly honest 404 that is indistinguishable from a broken reader.
 */
export function lessonExecutionPolicyPath(workspaceRoot?: string): string {
  return join(
    workspaceRoot ?? process.env["WORKSPACE_ROOT"] ?? "/workspace",
    "policies",
    "lesson-execution-policy.json",
  );
}

/**
 * Usable means EXPLICITLY ENABLED. `verbatimCommands` must be the literal boolean `true`.
 *
 * The string "true", 1, and "yes" are all REFUSED. This is the one switch in the fleet whose
 * accidental truthiness would hand autonomously-authored text a deterministic path to the
 * shell, so it does not get JavaScript's coercion rules. A policy that does not enable anything
 * is treated as absent, so the consumer keeps its fail-closed default rather than caching a
 * successful resolve that means "off".
 */
export function isUsablePolicy(v: unknown): v is LessonExecutionPolicy {
  if (typeof v !== "object" || v === null) return false;
  return (v as Record<string, unknown>)["verbatimCommands"] === true;
}

/**
 * Resolve the stored policy, or null when verbatim execution is not explicitly enabled.
 * Any read or parse failure is null — a corrupt file must fail CLOSED.
 */
export async function resolveLessonExecutionPolicy(
  workspaceRoot?: string,
  readFileImpl: (p: string) => Promise<string> = (p) => readFile(p, "utf-8"),
): Promise<LessonExecutionPolicy | null> {
  let raw: string;
  try {
    raw = await readFileImpl(lessonExecutionPolicyPath(workspaceRoot));
  } catch {
    return null; // absent is the normal case and the safe one
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isUsablePolicy(parsed) ? parsed : null;
}
