/**
 * THE REACH ORACLE FOR A GAP INVESTIGATION: DID IT PRODUCE SOMETHING ON THE GAP? (CHANGE-35, Class A)
 *
 * "investigate (and decompose) gap X" goals had no grader: the citation oracle is deliberately not applicable to them
 * (f031f26, 10-10: grading uncited gap answers on citations produced 122 of 208 last-pick β), so every one ended
 * ungraded (RUN 0, 2026-10-16: 7 of 17). And none of them wrote anything to gap X: the walk ran them as free text.
 * Now the investigation's product is a DECOMPOSITION of X through development-vessel's existing decomposeGap (advertised
 * as gapDecomposition), and this oracle reads it CONSUMER-SIDE, after the run:
 *   - the run's own gapDecomposition output names the child steps it CREATED for X (`created`: steps that were not
 *     already X's; child ids are deterministic, so a re-decomposition rewrites existing steps, and those are no product);
 *   - each is read back from the gap store and must be a child of X (classification_metadata.parent_gap_id === X);
 *   - reached iff at least one is confirmed. A run that produced no decomposition of X, or none the store confirms, is
 *     NOT reached (deterministic), never an abstain. investigated_at is never evidence: it is stamped at dispatch.
 * An unreadable gap store decides nothing (null: the chain continues).
 */
import type { PoolEvidence } from "./grounded-report";

export interface GapInvestigationVerdict { reached: boolean; reason: string; deterministic: true; completion_shapes: string[] }
export interface GapRow { id?: string; classification_metadata?: Record<string, unknown> }
export interface GapInvestigationDeps {
  /** One gap by id from the gap store, null when it does not exist; throws when the store is unreadable. */
  readGap: (id: string) => Promise<GapRow | null>;
}
export const MAX_CHILDREN_CHECKED = 10;

/** The run's own decomposition product: the gapDecomposition impulse it pooled, as {gap id, children}. */
export function gapDecompositionProduct(pool: readonly PoolEvidence[] | undefined): { gapId: string; children: string[]; reason: string } | null {
  for (const p of [...(pool ?? [])].reverse()) {
    if (p.shape !== "gapDecomposition") continue;
    const c = (p.content ?? {}) as Record<string, unknown>;
    const b = (c.body && typeof c.body === "object" ? c.body : c) as Record<string, unknown>;
    const gapId = typeof b.gap_id === "string" ? b.gap_id : "";
    // ONLY the steps this run CREATED (development-vessel's gapDecomposition reports `created`); an answer without it
    // created nothing that can be told apart from what was already there.
    const children = Array.isArray(b.created) ? b.created.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    return { gapId, children, reason: typeof b.reason === "string" ? b.reason : "" };
  }
  return null;
}

/** The verdict for a gap-investigation goal whose gap is `gapId` (null: not decidable here). */
export async function verifyGapInvestigationOutcome(gapId: string | null, pool: readonly PoolEvidence[] | undefined, deps: GapInvestigationDeps): Promise<GapInvestigationVerdict | null> {
  if (!gapId) return null;
  const prod = gapDecompositionProduct(pool);
  if (!prod || (prod.gapId && prod.gapId !== gapId)) {
    return { reached: false, deterministic: true, completion_shapes: [], reason: `deterministic:gap-investigation-no-product — the investigation of gap ${gapId} produced no decomposition of it (nothing was written onto the gap)` };
  }
  if (prod.children.length === 0) {
    return { reached: false, deterministic: true, completion_shapes: [], reason: `deterministic:gap-investigation-no-product — the decomposition of gap ${gapId} created no new step${prod.reason ? ` (${prod.reason.slice(0, 200)})` : ""}` };
  }
  let confirmed = 0;
  try {
    for (const child of prod.children.slice(0, MAX_CHILDREN_CHECKED)) {
      const row = await deps.readGap(child);
      if (row && String(row.classification_metadata?.parent_gap_id ?? "") === gapId) confirmed += 1;
    }
  } catch {
    return null; // the gap store could not be read: decide nothing
  }
  if (confirmed === 0) {
    return { reached: false, deterministic: true, completion_shapes: [], reason: `deterministic:gap-investigation-unconfirmed — the run reported ${prod.children.length} step(s) for gap ${gapId}, but the gap store holds none of them as its children` };
  }
  return { reached: true, deterministic: true, completion_shapes: ["gapDecomposition"], reason: `deterministic:gap-investigation-product — ${confirmed} child step(s) of gap ${gapId} confirmed in the gap store` };
}
