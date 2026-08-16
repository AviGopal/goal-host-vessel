/**
 * Serving `walkBudget` — the second shape the walk reads and nobody served.
 *
 * WHY THIS EXISTS (2026-08-16). The law-1 remediation that replaced the floor's hard-coded
 * iteration/call/timeout constants with a shaped `walkBudget` impulse shipped the READER and
 * never the PRODUCER. That was my own miss, and it is observable: goal-host logs, on every
 * floor entry,
 *
 *     floor: walkBudget resolve failed (no resolver for shape) — FALLING BACK to literal
 *     budget iters=4 calls=8 iterMs=90000 wallMs=210000
 *
 * Confirmed by the consumer's own instrument on 2026-08-16 — a discovery
 * `vesselCapability` lookup returns 2 vessels for `memoryNote` and 2 for `bodyHonestyPolicy`,
 * and 0 for `walkBudget`. So every knob the fix was meant to make steerable stayed a
 * process-frozen literal, and the fix read as landed. A reader without a producer is not a
 * law-1 fix; it is the same constant with a longer code path.
 *
 * WHAT THIS DELIBERATELY IS NOT. Serving a frozen default would silence the log without making
 * anything learnable — the value would still need a code edit to change, which is the exact
 * violation the shape exists to close, wearing a producer's clothes. So the budget is read from
 * the container volume AT USE TIME:
 *
 *   - present and usable → serve it; the walk's budget becomes editable data
 *   - absent or malformed → serve NOTHING, so the consumer keeps its documented literal
 *     fallback and keeps logging. Absent must not be indistinguishable from a zero budget:
 *     `max_iters: 0` would mean "the floor may take no steps", silently disabling the ReAct
 *     floor fleet-wide — worse than the gap staying open.
 *
 * The consumer clamps every field to its own range (index.ts: iters 1..20, calls 1..32,
 * iter_timeout 5s..PROXY_TIMEOUT_MS, wall_clock 10s..PROXY_TIMEOUT_MS) and keeps its current
 * value for anything out of range. Validation here is therefore about refusing a file that is
 * not a budget at all, not about re-implementing the consumer's clamps.
 *
 * NO `_write` COMPANION, for the same reason bodyHonestyPolicy has none: anything that can
 * write this can set the wall clock to its floor and starve every walk. Seeding is an
 * operator/seeder act until there is a reason to widen it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Mirrors the fields the floor reads at index.ts (`num(b[...])`). All optional: a partial
 *  budget is legitimate — the consumer keeps its current value for anything not supplied. */
export interface WalkBudget {
  max_iters?: number;
  max_calls_per_iter?: number;
  iter_timeout_ms?: number;
  wall_clock_ms?: number;
}

/**
 * Same volume convention as bodyHonestyPolicy: WORKSPACE_ROOT/policies/<name>.json
 *
 * ★ WORKSPACE_ROOT IS NOT /workspace. goal-host's unit carries
 * `WORKSPACE_ROOT="/workspace/git/super-repo"`, so this resolves under that. Seeding at
 * /workspace/policies/ yields a perfectly honest 404 that looks exactly like a broken reader.
 * Always resolve from the env the unit actually has.
 */
export function walkBudgetPath(workspaceRoot?: string): string {
  return join(workspaceRoot ?? process.env["WORKSPACE_ROOT"] ?? "/workspace", "policies", "walk-budget.json");
}

/**
 * A stored budget is usable only if at least one field is a positive finite number and no
 * present field is nonsense. A file of all-absent fields is NOT usable: it would resolve
 * successfully, log "SHAPED", and change nothing — a producer that reports success by
 * existing, which is the failure mode this whole class of fix keeps running into.
 */
export function isUsableBudget(v: unknown): v is WalkBudget {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  const fields = ["max_iters", "max_calls_per_iter", "iter_timeout_ms", "wall_clock_ms"] as const;
  let present = 0;
  for (const k of fields) {
    if (b[k] === undefined || b[k] === null) continue;
    const n = typeof b[k] === "number" ? (b[k] as number) : typeof b[k] === "string" ? Number(b[k]) : NaN;
    if (!Number.isFinite(n) || n <= 0) return false;
    present++;
  }
  return present > 0;
}

/**
 * Resolve the stored budget, or null when there is none to serve.
 *
 * Null is the honest answer for "no budget configured" and preserves the consumer's fallback.
 * Any read or parse failure is also null — a corrupt file must degrade to the documented
 * literals, never to a half-parsed budget.
 */
export async function resolveWalkBudget(
  workspaceRoot?: string,
  readFileImpl: (p: string) => Promise<string> = (p) => readFile(p, "utf-8"),
): Promise<WalkBudget | null> {
  let raw: string;
  try {
    raw = await readFileImpl(walkBudgetPath(workspaceRoot));
  } catch {
    return null; // absent is the normal case until an operator seeds one
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isUsableBudget(parsed) ? parsed : null;
}
