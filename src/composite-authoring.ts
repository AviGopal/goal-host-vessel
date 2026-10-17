/**
 * THE WALK BUILDS A PRODUCER FOR A NOVEL TARGET FROM EXISTING RESOLVERS (B2 + A2; gap walk-composite-authoring-
 * escalation-for-novel-target-shape-removed-without-a-gap).
 *
 * 6497517 wired development-vessel's author_composed_capability into the walk's escalate branch; af61dee removed the
 * call sites with no gap filed, so a goal whose target no single producer serves ended "no producer or constructible
 * payload" and waited for the capability-gap pipeline. Restored, once per walk:
 *   WHEN   (a) a target shape is missing and nothing produces it (the escalate branch, before the capability gap), or
 *          (b) the target chooser answered NOVEL (no candidate's production satisfies the goal) and the walk has no
 *              target and no step yet: composing first beats wandering over producers the chooser already ruled out.
 *   HOW    author_composed_capability, reached through discovery (whichever vessel serves it), plans a short chain of
 *          EXISTING resolvers and mints it (reuse-before-mint: it returns an existing composite when one produces the
 *          shape). The walk executes the minted template as its pick; the reach gate grades it on that first run.
 *   A2     after the composite RAN and produced real content of its output shape in this walk, the shape's meaning is
 *          written to discovery's learned descriptions with produced_by = the minted template, so concept-db's shape
 *          index recalls it for the next goal that means it (paraphrases included). The description is the chooser's
 *          residual, in its words, never the goal text. Written only on a NOVEL decision (a shape that already had a
 *          name had its description already), and never fatal to the walk.
 * Any refusal (structuredError, no plan, no discovery row, a timeout) falls through to the honest capability gap.
 *
 * NAMED DEBT (development-vessel, not this module): author_composed_capability names a novel deliverable by a slug of
 * the goal text (deliverableShape), so two paraphrases of one novel goal mint two shapes; and its isAggregateGoal is a
 * wording rule. Both are pre-existing.
 */

export interface ComposedPick { id: string; outputShapes: string[]; reusedExisting: boolean }
export type ComposeOutcome = { ok: true; pick: ComposedPick } | { ok: false; reason: string };

export interface ComposeDeps {
  /** the resolve URL of the vessel serving a shape, via discovery (null when none serves it) */
  resolveUrl: (shape: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  timeoutMs: number;
}

/** Whether the walk should try composing now. Pure: the caller passes the walk's state. */
export function composeTrigger(s: { tried: boolean; goal: string; hasPick: boolean; missing: readonly string[]; targetSize: number; novel: boolean; steps: number }): "missing_target" | "novel_target" | null {
  if (s.tried || !s.goal) return null;
  if (!s.hasPick && s.missing.length > 0) return "missing_target";
  if (s.novel && s.targetSize === 0 && s.steps === 0) return "novel_target";
  return null;
}

/** Ask author_composed_capability (wherever discovery places it) for a composite producing `targetShapes`. */
export async function authorComposite(goal: string, targetShapes: readonly string[], availableShapes: readonly string[], executionId: string | undefined, deps: ComposeDeps): Promise<ComposeOutcome> {
  const url = await deps.resolveUrl("author_composed_capability");
  if (!url) return { ok: false, reason: "no vessel serves author_composed_capability" };
  const f = deps.fetchImpl ?? fetch;
  try {
    const r = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(deps.apiKey ? { Authorization: `ApiKey ${deps.apiKey}` } : {}) },
      body: JSON.stringify({ impulse: { type: "author_composed_capability", pointer: { type: "author_composed_capability", goal, target_shapes: [...targetShapes], available_shapes: [...availableShapes], max_attempts: 2, ...(executionId ? { execution_id: executionId } : {}) } } }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (!r.ok) return { ok: false, reason: `author_composed_capability HTTP ${r.status}` };
    const j = (await r.json()) as { shape?: string; body?: Record<string, unknown> } & Record<string, unknown>;
    const b = (j?.body ?? j) as Record<string, unknown>;
    if (j?.shape === "structuredError") return { ok: false, reason: `author_composed_capability refused: ${String(b?.error ?? "no reason")}`.slice(0, 300) };
    const id = typeof b?.minted_activity_id === "string" ? b.minted_activity_id : "";
    if (!id || b?.validated !== true) return { ok: false, reason: "author_composed_capability returned no validated composite" };
    const out = Array.isArray(b.output_shapes) ? (b.output_shapes as unknown[]).map(String).filter(Boolean) : [];
    return { ok: true, pick: { id, outputShapes: out.length > 0 ? out : [...targetShapes], reusedExisting: b.reused_existing === true } };
  } catch (e) {
    return { ok: false, reason: `author_composed_capability unreachable: ${(e as Error).message}`.slice(0, 300) };
  }
}

/** A2: describe a minted shape in discovery's learned vocabulary, claimed by the template that produced it. */
export async function describeMintedShape(discoveryEndpoint: string, shape: string, residual: string, producedBy: string, deps: Omit<ComposeDeps, "resolveUrl">): Promise<{ ok: boolean; status: number | null; reason: string }> {
  const description = residual.trim();
  if (!discoveryEndpoint || !shape || !description || !producedBy) return { ok: false, status: null, reason: "nothing to describe" };
  const f = deps.fetchImpl ?? fetch;
  try {
    const r = await f(`${discoveryEndpoint.replace(/\/+$/, "")}/registry/shape-descriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(deps.apiKey ? { Authorization: `ApiKey ${deps.apiKey}` } : {}) },
      body: JSON.stringify({ shape, description, source: "walk_composite", produced_by: producedBy }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (r.ok) return { ok: true, status: r.status, reason: "described" };
    let why = "";
    try { why = String(((await r.json()) as { reason?: unknown; error?: unknown })?.reason ?? ""); } catch { /* body unreadable */ }
    return { ok: false, status: r.status, reason: why || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, status: null, reason: (e as Error).message };
  }
}

/**
 * EARNED BY DOING (law 3/4; qa condition on B2): author_composed_capability mints on VALIDATION, before the composite
 * has ever reached. A composite this walk MINTED (not one it reused, which carries its own history) whose dispatch then
 * does NOT reach is retired (activityTemplate_deprecate sets the `retired` flag every selection path filters on; it is
 * reversible through activityTemplate_update), so a wrong mint does not stay an ordinary Thompson arm. A reached first
 * run leaves it a normal activity. An UNKNOWN verdict (reached null: the judge did not answer) retires nothing.
 */
export class ComposedLedger {
  private byDispatch = new Map<string, ComposedPick[]>();
  constructor(private readonly cap = 256) {}
  note(dispatchId: string, pick: ComposedPick): void {
    if (!dispatchId) return;
    if (!this.byDispatch.has(dispatchId) && this.byDispatch.size >= this.cap) {
      const oldest = this.byDispatch.keys().next().value;
      if (oldest !== undefined) this.byDispatch.delete(oldest);
    }
    this.byDispatch.set(dispatchId, [...(this.byDispatch.get(dispatchId) ?? []), pick]);
  }
  take(dispatchId: string): ComposedPick[] {
    const v = this.byDispatch.get(dispatchId) ?? [];
    this.byDispatch.delete(dispatchId);
    return v;
  }
}

/** The composites to retire once the dispatch's verdict is known: newly minted ones, and only on a definite miss. */
export function compositesToRetire(composed: readonly ComposedPick[], reached: boolean | null | undefined): string[] {
  if (reached !== false) return [];
  return [...new Set(composed.filter((c) => !c.reusedExisting).map((c) => c.id))];
}

export async function retireComposite(templateId: string, reason: string, deps: ComposeDeps): Promise<{ ok: boolean; status: number | null; reason: string }> {
  const url = await deps.resolveUrl("activityTemplate_deprecate");
  if (!url) return { ok: false, status: null, reason: "no vessel serves activityTemplate_deprecate" };
  const f = deps.fetchImpl ?? fetch;
  try {
    const r = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(deps.apiKey ? { Authorization: `ApiKey ${deps.apiKey}` } : {}) },
      body: JSON.stringify({ pointer: { type: "activityTemplate_deprecate", templateId, reason } }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (r.ok) return { ok: true, status: r.status, reason: "retired" };
    let why = "";
    try { why = String(((await r.json()) as { error?: unknown })?.error ?? ""); } catch { /* body unreadable */ }
    return { ok: false, status: r.status, reason: (why || `HTTP ${r.status}`).slice(0, 200) };
  } catch (e) {
    return { ok: false, status: null, reason: (e as Error).message };
  }
}
