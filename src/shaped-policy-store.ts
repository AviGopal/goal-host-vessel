/**
 * Stored producers for the two shaped policies whose READERS shipped without one.
 *
 * extractionPolicy   — read by resolveMaxExtractionDepth here and by the ribosome, which
 *                      records the cost in its own source: "null is the COMMON case:
 *                      extractionPolicy resolved 0 of 1446 times in 6h".
 * pathwayReusePolicy — read by resolvePathwayReusePolicy and consumed by
 *                      recommendReachingPath to filter learned pathways on
 *                      minSuccessfulExecutions / minTotalExecutions. With no producer every
 *                      call took the "FALLING BACK to literal acceptance" branch, so the
 *                      thresholds governing PATHWAY REUSE — the stated learning ceiling —
 *                      could never be tuned by an impulse.
 *
 * Same contract as walk-budget.ts and the body-honesty policy: serve the STORED document so
 * the behaviour is editable data (law 1), and serve NOTHING when none is stored so the
 * consumer keeps its documented literal fallback. A read or parse failure is also nothing —
 * a corrupt file must degrade to the literals, never to a half-parsed policy.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function shapedPolicyPath(shape: string, workspaceRoot?: string): string {
  const root = workspaceRoot ?? process.env["WORKSPACE_ROOT"] ?? "/workspace";
  return join(root, "policies", shape + ".json");
}

/** A usable policy is a non-array object carrying at least one key. */
export function isUsablePolicy(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0;
}

export async function resolveShapedPolicy(
  shape: string,
  workspaceRoot?: string,
  readFileImpl: (p: string) => Promise<string> = (p) => readFile(p, "utf-8"),
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFileImpl(shapedPolicyPath(shape, workspaceRoot));
  } catch {
    return null; // absent is the normal case until an operator or activity seeds one
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isUsablePolicy(parsed) ? parsed : null;
}
