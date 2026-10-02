/**
 * THE WALK'S POOL CARRIES DATA FLOW, NOT JUST SHAPE NAMES (agentic-floor B1/B2/B4).
 *
 * MEASURED (agentic-floor track B, node 1, 09-10 → 10-01): every pool impulse's `producedBy` was the
 * constant "goal-host-walk"; pool ids `walk-<shape>-<n>` came from a per-walk counter and collided
 * across walks; no consumed ids were recorded; walk composites declared POSITIONAL edges (step i
 * consumes step i-1, whatever was bound — 9/178 named a template id as an input shape); and the
 * llm/terminal satisfier declared every chain-produced shape consumed on the shape NAME alone, so
 * the stored 10-01 08:57–08:59Z rows say `web_search` fed a goal-only prompt (CONSUMPTION-EDGE-
 * ANALYSIS: "declare consumption ONLY where a step was actually bound").
 *
 * This module holds the pieces the walk needs to record what it actually did, as pure functions
 * the walk's closures call (so the binding rule is testable without booting the server).
 */

/** A pool impulse as the walk holds it (structurally the engine's Impulse). */
export interface PoolImpulseLike {
  id: string;
  metadata?: Record<string, unknown>;
  content?: unknown;
}

import { isProvenanceStub } from "./judge-view";

// ── B4: declare consumption only when bound ────────────────────────────────────

/**
 * The findings block a deferred terminal write / an llm_completion synthesis binds, AND the shapes
 * it actually put into it. "" / [] when nothing was bound — which is every re-frame (no terminal
 * shapes) and every pool with no content-bearing intermediate. The shape list is the ONLY source of
 * a consumption edge for these satisfiers.
 */
export function findingsDigest(pool: readonly PoolImpulseLike[], terminalShapes: ReadonlySet<string>): { text: string; shapes: string[] } {
  if (terminalShapes.size === 0) return { text: "", shapes: [] };
  const parts: string[] = [];
  const shapes: string[] = [];
  for (const imp of pool) {
    const sh = (imp.metadata as { shape?: string } | undefined)?.shape;
    if (!sh || terminalShapes.has(sh) || sh === "goal") continue;
    let c: string;
    try { c = typeof imp.content === "string" ? imp.content : JSON.stringify(imp.content, null, 2); }
    catch { c = String(imp.content); } if (c === undefined || c === null) c = "";
    if (!c || c.trim().length === 0 || c.trim() === "{}" || c.trim() === "[]") continue;
    parts.push(`## ${sh}\n\n\`\`\`json\n${c.slice(0, 8000)}\n\`\`\``);
    shapes.push(sh);
  }
  if (parts.length === 0) return { text: "", shapes: [] };
  return { text: `# Findings\n\n${parts.join("\n\n")}\n`, shapes };
}

/** The consumption a satisfier step declares: exactly the shapes its resolve BOUND, limited to
 *  shapes an earlier chain step produced (seeds and the step's own output never count). */
export function boundConsumption(bound: Iterable<string>, chainProduced: ReadonlySet<string>, satisfied: string, terminalShapes: ReadonlySet<string>): string[] {
  return [...new Set([...bound])].filter((s) => s !== "goal" && s !== satisfied && !terminalShapes.has(s) && chainProduced.has(s));
}

// ── B1: pool impulses carry their producer, the producing execution, and what they consumed ───

let poolImpulseSeq = 0;
/** Per-process nonce: a requeued dispatch keeps its dispatch id across a restart while the counter
 *  resets, so without it a restarted process re-mints ids the store already holds (qa). */
const BOOT_NONCE = Math.random().toString(36).slice(2, 8).padEnd(6, "0");

/** A short stable digest of the WHOLE dispatch id (FNV-1a): a prefix collapses ids that share one
 *  (`dispatch-drop-*` all became `dispatch`). */
function dispatchDigest(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).padStart(7, "0");
}

/** Pool impulse id, unique per dispatch, per process and per impulse:
 *  `walk-<boot>-<dispatch digest>-<shape>-<n>`. The old `walk-<shape>-<n>` restarted at 1 every walk,
 *  so two walks (or two retries inside one dispatch) minted the same id for different content. No
 *  reader parses the id; the extractor joins on it. */
export function poolImpulseId(dispatchId: unknown, shape: string): string {
  const d = typeof dispatchId === "string" && dispatchId ? dispatchDigest(dispatchId) : "nodisp";
  return `walk-${BOOT_NONCE}-${d}-${shape}-${++poolImpulseSeq}`;
}

/** Who put an impulse in the pool. `producedBy` is the real producer (`satisfier:<shape>`, a
 *  template id, `seed`), never the constant; the execution id and consumed ids are set when known. */
export interface PoolProvenance { producedBy: string; producerExecutionId?: string; consumedIds?: string[] }

/** The pool ids (first impulse per shape, the pool's first-wins rule) of the given shapes. */
export function poolIdsOf(pool: readonly PoolImpulseLike[], shapes: Iterable<string>): string[] {
  const want = new Set(shapes);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const imp of pool) {
    const sh = String((imp.metadata as { shape?: unknown } | undefined)?.shape ?? "");
    if (want.has(sh) && !seen.has(sh)) { seen.add(sh); out.push(imp.id); }
  }
  return out;
}

// ── B2: a composite's edges are the steps' recorded edges, not positions ────────────────

/** What one chain step bound and produced, recorded when the step ran. */
export interface StepEdge { inputShapes: string[]; inputImpulseIds: string[]; outputShapes: string[]; outputImpulseIds: string[] }

/** Inputs a template step bound: its declared input shapes that the pool held before it ran. */
export function declaredBound(declaredInputs: readonly string[] | undefined, poolBefore: Iterable<string>): string[] {
  const have = new Set(poolBefore);
  return [...new Set((declaredInputs ?? []).filter((s) => s !== "goal" && have.has(s)))];
}

/** One step's edge record from the pool as it stands after the step. Output ids skip provenance
 *  stubs (`{producedBy, executionId}`): a template step that recovered no content produced no
 *  impulse a consumer could bind, so it contributes no output id — and so cannot count toward the
 *  composite's "≥ 2 tasks produced pool impulses" grounding on a stub. */
export function stepEdgeOf(pool: readonly PoolImpulseLike[], inputShapes: readonly string[], outputShapes: readonly string[]): StepEdge {
  return {
    inputShapes: [...inputShapes],
    inputImpulseIds: poolIdsOf(pool, inputShapes),
    outputShapes: [...outputShapes],
    outputImpulseIds: poolIdsOf(pool.filter((i) => !isProvenanceStub(i.content)), outputShapes),
  };
}

/** "≥ 2 tasks with real edges" (the slice's own criterion): some task consumed an impulse an EARLIER
 *  task of the same composite produced. Two output-bearing tasks with no such edge are two
 *  independent reads, not a recipe — they must not be minted as one. */
export function hasRealEdge(tasks: ReadonlyArray<{ inputImpulseIds?: readonly string[]; outputImpulseIds?: readonly string[] }>): boolean {
  const produced = new Set<string>();
  for (const t of tasks) {
    if ((t.inputImpulseIds ?? []).some((id) => produced.has(id))) return true;
    for (const id of t.outputImpulseIds ?? []) produced.add(id);
  }
  return false;
}
