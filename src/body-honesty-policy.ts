/**
 * Serving `bodyHonestyPolicy` — the shape the walk already reads and nobody served.
 *
 * WHY THIS EXISTS (task #61, 2026-08-10). The walk resolves `bodyHonestyPolicy`
 * through discovery on every use, exactly as law 1 requires, and falls open to a
 * literal list when nothing answers — logging each time:
 *
 *     bodyHonestyPolicy NOT advertised in discovery — FALLING BACK to the literal
 *     denial-field list [...] (law-1 fallback, logged)
 *
 * Measured with `registry_query {mode:"shapes"}`: **0 of 417** advertised shapes
 * match. The reader was correct and complete; there was simply no producer, so
 * the fallback fired on every walk and the vocabulary could never be learned.
 *
 * WHAT THIS DELIBERATELY IS NOT. Serving a frozen constant would silence the log
 * without making anything learnable — the value would still be unchangeable
 * without a code edit, which is precisely the law-1 violation the shape exists to
 * fix, now wearing a producer's clothes. So the policy is read from the container
 * volume at USE TIME:
 *
 *   - present → serve it; the fleet's denial vocabulary is now editable data
 *   - absent  → return NOTHING (404 via the caller), so the consumer keeps its
 *     documented fallback and keeps logging. An absent file must not be
 *     indistinguishable from an empty policy: an empty `flagFields` would mean
 *     "nothing marks a denial" and would silently disable the honesty check
 *     fleet-wide. That failure mode is worse than the gap being open.
 *
 * NO `_write` COMPANION, unlike `llmModelPolicy_write`. A writable denial
 * vocabulary is a path to disabling the substrate's own honesty gate — any actor
 * that can write it can set `flagFields: []` and make every hollow body read as
 * honest. Seeding it is an operator/seeder act until there is a reason to widen
 * that, and the read path is useful on its own.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Mirrors `_BodyHonesty` at the consumer (goal-host index.ts). */
export interface BodyHonestyPolicy {
  envelopeKeys: string[];
  flagFields: string[];
  truthyDenialFields: string[];
  errorFields: string[];
  statusFields: string[];
  payloadFields: string[];
  denialTextPattern: string;
}

/** Same volume convention as llm-resolver's model policy: WORKSPACE_ROOT/policies/<name>.json */
export function bodyHonestyPolicyPath(workspaceRoot?: string): string {
  return join(workspaceRoot ?? process.env["WORKSPACE_ROOT"] ?? "/workspace", "policies", "body-honesty-policy.json");
}

/**
 * A stored policy is only usable if it can actually classify a denial.
 *
 * Rejecting a malformed file is the whole safety property: the consumer treats
 * ANY returned policy as authoritative and replaces its literal list wholesale,
 * so a file with `flagFields: []` would disable denial detection everywhere.
 * Serving nothing keeps the documented fallback; serving junk silently weakens
 * the gate — the same "a mechanism that reports success by counting its own
 * actions" trap this session kept finding.
 */
export function isUsablePolicy(v: unknown): v is BodyHonestyPolicy {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  const arrays = ["envelopeKeys", "flagFields", "truthyDenialFields", "errorFields", "statusFields", "payloadFields"];
  for (const k of arrays) {
    if (!Array.isArray(p[k]) || (p[k] as unknown[]).some((x) => typeof x !== "string")) return false;
  }
  if (typeof p["denialTextPattern"] !== "string" || (p["denialTextPattern"] as string).length === 0) return false;
  // A policy that marks nothing as a denial is not a policy — it is an off switch.
  if ((p["flagFields"] as string[]).length === 0 && (p["errorFields"] as string[]).length === 0) return false;
  // The pattern is fed to RegExp at the consumer; an invalid one would throw
  // there, INSIDE the walk, which is the worst place to discover it.
  try { new RegExp(p["denialTextPattern"] as string); } catch { return false; }
  return true;
}

/**
 * Resolve the stored policy, or null when there is none to serve.
 *
 * Null is the honest answer for "no policy configured" and preserves the
 * consumer's fallback. Any read or parse failure is also null — a corrupt file
 * must degrade to the documented literal list, never to a half-parsed one.
 */
export async function resolveBodyHonestyPolicy(
  workspaceRoot?: string,
  readFileImpl: (p: string) => Promise<string> = (p) => readFile(p, "utf-8"),
): Promise<BodyHonestyPolicy | null> {
  let raw: string;
  try {
    raw = await readFileImpl(bodyHonestyPolicyPath(workspaceRoot));
  } catch {
    return null; // absent is the normal case until an operator seeds one
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isUsablePolicy(parsed) ? parsed : null;
}
