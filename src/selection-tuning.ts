/**
 * Selection tuning constants, read as DATA at use time rather than frozen in the binary.
 *
 * WHY THIS EXISTS (2026-08-17). I introduced `EDGE_BLEND_K` as an exported in-process
 * constant and justified it in edge-blend.ts by pointing at the walk's `MAX_STEPS`. Law 1
 * says the opposite, and says it about exactly this:
 *
 *     "Env vars, config files, and in-process constants are bootstrap-only (secrets, ports,
 *      identity): they are frozen at process start, invisible to traces and the walk, and
 *      unlearnable. Never gate behavior behind anything the system cannot observe through a
 *      shaped impulse."
 *
 * K decides how fast per-edge evidence overtakes a candidate's global posterior. That is
 * selection behaviour, and behaviour is precisely what may not live in a constant. Citing
 * MAX_STEPS did not license it — it identified a SECOND violation. Consistency with an
 * existing breach is not compliance.
 *
 * WHAT WOULD HAVE MADE THIS COSMETIC. Serving a frozen value through a policy file would
 * silence the objection while leaving K unchangeable without a code edit — the same
 * violation wearing a producer's clothes, which is the trap body-honesty-policy.ts already
 * names. So the value is genuinely editable: write the file, and the next read inside one
 * TTL window uses it. No restart, no redeploy.
 *
 * THE FALLBACK IS THE CURRENT BEHAVIOUR, EXACTLY. With no policy file — the shipped state —
 * every getter returns the literal that was previously compiled in, so this change is
 * provably inert until someone authors a value. That property is what makes it landable
 * while the substrate's own store is down and no A/B is possible.
 *
 * TTL RATHER THAN PER-CALL READ. `getTuningParam` in activity-api sets the fleet's meaning
 * of "at use time" for this class: a 30s in-memory TTL, so an authored value takes effect
 * within one window while the hot path stays off the filesystem. Matching it is law 3 —
 * reuse the established convention rather than minting a second one that can drift.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
// ONE SOURCE OF TRUTH FOR THE DEFAULT. edge-blend.ts owns the value because it owns the
// math; this module owns how it is RESOLVED. Declaring `10` here as well would be two
// constants that agree today and drift silently the first time either is tuned — the
// write-key/read-key class with numbers instead of names. The dependency runs one way
// (edge-blend imports nothing from here), so there is no cycle.
import { EDGE_BLEND_K } from "./edge-blend";

/** Same volume convention as body-honesty-policy and llm-resolver's model policy.
 *
 *  ★ WORKSPACE_ROOT IS NOT /workspace on this fleet — goal-host's unit carries
 *  `/workspace/git/super-repo`. Seeding at the literal produces an honest "not configured"
 *  that is indistinguishable from a broken reader. Always resolve from the env the unit has. */
export function selectionTuningPath(workspaceRoot?: string): string {
  return join(workspaceRoot ?? process.env["WORKSPACE_ROOT"] ?? "/workspace", "policies", "selection-tuning.json");
}

/** The compiled-in values. Returned verbatim whenever no usable policy is present, so the
 *  unconfigured path is byte-for-byte the behaviour that shipped before this file existed. */
export interface SelectionTuning {
  /** Edge-evidence half-life: at K samples on an A->B edge, the per-edge posterior carries
   *  half the weight of the candidate's global posterior. */
  edgeBlendK: number;
}

export const SELECTION_TUNING_DEFAULTS: Readonly<SelectionTuning> = Object.freeze({
  edgeBlendK: EDGE_BLEND_K,
});

/**
 * A stored value is usable only if it can't silently disable or invert the blend.
 *
 * This is the load-bearing half. The consumer treats whatever comes back as authoritative,
 * so a junk file must fall back rather than take effect:
 *   - K <= 0 makes `samples/(samples+K)` either divide by zero or exceed 1, which would let
 *     a single sample outweigh a mature posterior — the untried-prior failure this codebase
 *     already measured (a .755-success arm winning 0.0% of draws).
 *   - a non-finite K poisons every score into NaN, and NaN comparisons are silently false,
 *     so ranking would degrade to input order with no error anywhere.
 * Both are worse than the unconfigured state, which is why "unusable" and "absent" are
 * treated identically: keep the documented default.
 */
export function isUsableEdgeBlendK(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

interface CacheEntry { value: SelectionTuning; expiresAt: number }
let cache: CacheEntry | null = null;

/** Match activity-api's getTuningParam window so the fleet has ONE notion of "at use time". */
export const SELECTION_TUNING_TTL_MS = 30_000;

/** Drop the cache. Tests only — production relies on the TTL. */
export function _resetSelectionTuningCache(): void { cache = null; }

/**
 * Resolve the current tuning, reading the policy volume at most once per TTL window.
 *
 * NEVER THROWS AND NEVER RETURNS PARTIAL DATA. A missing file, an unreadable one, invalid
 * JSON, or an out-of-range value all resolve to the documented defaults for the fields they
 * fail — a tuning lookup must not be able to break a walk. Every failure is silent BY
 * DESIGN here and loud at the call site, which logs once per window when a value overrides.
 */
export async function resolveSelectionTuning(workspaceRoot?: string): Promise<SelectionTuning> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  let value: SelectionTuning = SELECTION_TUNING_DEFAULTS;
  try {
    const raw = await readFile(selectionTuningPath(workspaceRoot), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const k = parsed["edgeBlendK"];
    // Field-by-field, so one bad field cannot discard a good one — and so adding a field
    // later cannot silently drop the others (the explicit-projection class, one layer up).
    value = { edgeBlendK: isUsableEdgeBlendK(k) ? k : SELECTION_TUNING_DEFAULTS.edgeBlendK };
  } catch {
    value = SELECTION_TUNING_DEFAULTS;
  }

  cache = { value, expiresAt: now + SELECTION_TUNING_TTL_MS };
  return value;
}
