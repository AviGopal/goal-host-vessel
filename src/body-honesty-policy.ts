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
 *   - present  → serve it; the fleet's denial vocabulary is now editable data
 *   - absent   → SELF-HEAL: write the documented default (identical to the consumer's literal
 *     fallback, so provisioning changes no behaviour) and serve it. Amended 2026-08-16 — this
 *     previously returned nothing, which was correct as a contract and wrong in practice: the
 *     file has not existed since 2026-08-02, so "absent" was the permanent state rather than a
 *     transient one, and the shape was unservable forever. See resolveBodyHonestyPolicy.
 *   - corrupt or unusable → still NOTHING, so the consumer keeps its documented fallback. An
 *     unusable file must not be indistinguishable from a valid one: an empty `flagFields` would
 *     mean "nothing marks a denial" and would silently disable the honesty check fleet-wide.
 *     That failure mode is worse than the gap being open, and unlike absence it is evidence
 *     someone edited the file — overwriting it would destroy that evidence.
 *
 * NO `_write` COMPANION, unlike `llmModelPolicy_write`. A writable denial
 * vocabulary is a path to disabling the substrate's own honesty gate — any actor
 * that can write it can set `flagFields: []` and make every hollow body read as
 * honest. Seeding it is an operator/seeder act until there is a reason to widen
 * that, and the read path is useful on its own.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

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

/**
 * Same volume convention as llm-resolver's model policy: WORKSPACE_ROOT/policies/<name>.json
 *
 * ★ WORKSPACE_ROOT IS NOT /workspace. Measured live 2026-08-10: goal-host's unit
 * carries `WORKSPACE_ROOT="/workspace/git/super-repo"`, so the policy lives at
 * /workspace/git/super-repo/policies/. Seeding it at /workspace/policies/ produced
 * a perfectly honest "no policy configured" 404 that looked exactly like a broken
 * reader — the third-tree confusion again (see the golden-drift note). Always
 * resolve this path from the ENV the unit actually has, never from the literal.
 */
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
 * The consumer's literal fallback, as data.
 *
 * This is a VERBATIM copy of `_honestyFallback` in index.ts — the list the walk drops to when
 * this shape resolves to nothing. Keeping the two in sync matters: seeding a DIFFERENT default
 * would silently change denial detection fleet-wide the first time the file is written, which is
 * the opposite of what a self-heal is for. Identical values mean provisioning the file is a
 * behavioural no-op, and every subsequent edit to it is a deliberate, observable change.
 */
export const DEFAULT_BODY_HONESTY_POLICY: BodyHonestyPolicy = {
  envelopeKeys: ["body", "content", "result", "data"],
  flagFields: ["success", "ok"],
  truthyDenialFields: [],
  errorFields: ["error", "failure_mode"],
  statusFields: ["status"],
  payloadFields: ["content", "text", "value", "stdout", "body", "result", "data", "notes", "items", "results", "rows", "tasks", "files", "matches", "executions", "traces"],
  denialTextPattern: "(required|missing|not\\s+found|unsupported|unauthoriz|forbidden|invalid|unavailable|refused|denied|cannot|failed|failure)",
};

/**
 * Resolve the stored policy, self-healing the file when it is absent.
 *
 * WHY SELF-HEAL (2026-08-16). This shape has had a producer and no FILE since `8f8e87e7`
 * (2026-08-02), *"chore: untrack the substrate's runtime state from the tree"*. That commit was
 * correct — the tracked copy had diverged from the live one, so git was carrying a stale snapshot
 * of a file the system maintains. What it did not do, and what nobody did after, is give the
 * untracked file a PROVIDER. So for two weeks the walk logged
 *
 *     bodyHonestyPolicy resolved to no usable body — FALLING BACK to the literal denial-field
 *     list (law-1 fallback, logged)
 *
 * on every single step, and nothing read it. "Stop git from carrying this" and "make sure
 * something still provides it" were treated as one task; they are two.
 *
 * The mechanism is copied from llm-resolver-vessel's `loadPolicy` (model-policy.ts:54-66), which
 * is why `llm-model-policy.json` REAPPEARS after the policies directory is wiped while the other
 * three files stay gone: it carries its default in code and writes it back on absence. That is
 * the difference between a policy that survives its storage being erased and one that does not.
 *
 * Absent → write the default, then serve it. Corrupt or unusable → still null, deliberately: a
 * malformed file is a signal someone edited it wrongly, and overwriting it would destroy the
 * evidence and could mask an attempt to weaken the gate. Write failures are swallowed — a
 * read-only or erased-again volume must degrade to today's behaviour, never break the walk.
 */
export async function resolveBodyHonestyPolicy(
  workspaceRoot?: string,
  readFileImpl: (p: string) => Promise<string> = (p) => readFile(p, "utf-8"),
  writeFileImpl?: (p: string, data: string) => Promise<void>,
): Promise<BodyHonestyPolicy | null> {
  let raw: string;
  try {
    raw = await readFileImpl(bodyHonestyPolicyPath(workspaceRoot));
  } catch {
    // ABSENT — provision the documented default so the shape has something to serve.
    const path = bodyHonestyPolicyPath(workspaceRoot);
    try {
      const write =
        writeFileImpl ??
        (async (p: string, data: string) => {
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, data, "utf-8");
        });
      await write(path, JSON.stringify(DEFAULT_BODY_HONESTY_POLICY, null, 2) + "\n");
      console.log(`[body-honesty-policy] provisioned the default policy at ${path} (was absent) — values identical to the consumer's literal fallback, so this changes no behaviour and makes the vocabulary editable`);
    } catch (e) {
      console.warn(`[body-honesty-policy] could not provision ${path} (${(e as Error)?.message ?? e}) — serving the default in-memory; the consumer's fallback is unchanged`);
    }
    return DEFAULT_BODY_HONESTY_POLICY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isUsablePolicy(parsed) ? parsed : null;
}
