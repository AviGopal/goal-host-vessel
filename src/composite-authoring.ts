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

import { walkEgressFetch } from "./walk-egress-guard";
import { doorTemplateKey, fetchedResolveWrites, isStoreWrite, isWriteShape } from "./write-door";

/** The send for one authoring shape: the caller's fetchImpl, else the walk egress door (walk-egress-guard.ts), which
 *  refuses template authoring under observe and otherwise sends exactly fetch(url, init). */
type Send = (url: string, init: RequestInit) => Promise<Response>;
const sendFor = (shape: string, deps: { fetchImpl?: typeof fetch }): Send => deps.fetchImpl ?? ((url, init) => walkEgressFetch(shape, url, init));

export interface ComposedPick { id: string; outputShapes: string[]; reusedExisting: boolean }
export type ComposeOutcome = { ok: true; pick: ComposedPick } | { ok: false; reason: string };

export interface ComposeDeps {
  /** the resolve URL of the vessel serving a shape, via discovery (null when none serves it) */
  resolveUrl: (shape: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  timeoutMs: number;
  /** activity-api's base URL: the stored composite is read back from it (lifecycle + tasks) before the walk takes it. */
  templateEndpoint?: string;
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
  const f = sendFor("author_composed_capability", deps);
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
    const reusedExisting = b.reused_existing === true;
    // THE STORED COMPOSITE, READ BACK. Its id is a content address (composedCapabilityTemplateId), so re-authoring the
    // same chain returns the id a miss already retired, and nothing on this path consulted the flag: the walk ran
    // retired composites again. Read with the BARE id: the by-id route caches under the id string it was given, and
    // activityTemplate_deprecate invalidates the bare key only, so the wrapped form the author returns can read a
    // pre-retirement copy. Refused, never re-minted: goal-host does not mint, and a fresh id for content already judged
    // bad would launder it into an uninformed arm. An unreadable row is not judged here (the loader still refuses a
    // retired template it can see).
    const stored = deps.templateEndpoint ? await readStoredTemplate(deps.templateEndpoint, id, deps) : null;
    if (stored && (stored.retired === true || stored.deprecated === true)) {
      return { ok: false, reason: `author_composed_capability returned ${doorTemplateKey(id)}, which is retired (retired=${String(stored.retired)} deprecated=${String(stored.deprecated)}): the same content already missed; not re-running it` };
    }
    // FAKE WRITERS: a task that DECLARES a write it does not resolve (an llm task "producing" uiView_write) cannot
    // perform the write, and no write door sees one. Judged on the plan the author returned and on the stored row
    // (for a reused composite they differ). A composite this walk minted is retired at once: it is wrong by construction.
    const fake = [...new Set([...fakeWriterTasks(b.tasks), ...fakeWriterTasks(stored?.tasks)])];
    if (fake.length > 0) {
      if (!reusedExisting) void retireComposite(doorTemplateKey(id), `minted with tasks that declare writes they do not resolve: ${fake.join(", ")}`, { ...deps, timeoutMs: Math.min(deps.timeoutMs, 8_000) }).catch(() => undefined);
      return { ok: false, reason: `author_composed_capability returned ${doorTemplateKey(id)} with tasks declaring writes they do not resolve: ${fake.join(", ")}`.slice(0, 300) };
    }
    return { ok: true, pick: { id, outputShapes: out.length > 0 ? out : [...targetShapes], reusedExisting } };
  } catch (e) {
    return { ok: false, reason: `author_composed_capability unreachable: ${(e as Error).message}`.slice(0, 300) };
  }
}

/** The stored template row (raw: lifecycle flags kept), or null when it cannot be read. A GET, sent like every other
 *  call on this path (the caller's fetchImpl, else the walk egress door). */
async function readStoredTemplate(endpoint: string, id: string, deps: Pick<ComposeDeps, "fetchImpl" | "apiKey" | "timeoutMs">): Promise<{ retired?: unknown; deprecated?: unknown; tasks?: unknown } | null> {
  const f = sendFor("activityTemplate_get", deps);
  try {
    const r = await f(`${endpoint.replace(/\/+$/, "")}/v2/activities/templates/${encodeURIComponent(doorTemplateKey(id))}`, {
      headers: deps.apiKey ? { Authorization: `ApiKey ${deps.apiKey}` } : {},
      signal: AbortSignal.timeout(Math.min(deps.timeoutMs, 10_000)),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown> | null;
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/**
 * Tasks that declare a write (a change or store-write shape, write-door.ts) their own resolver does not perform:
 * "<task id>:<shape>" for each. A task may declare a write only when it IS that write: its resolver (or the shape the
 * resolver serves), the pointer it sends, or the impulse an http_fetch POSTs to a resolve URL. A compose task is
 * exempt: its child template's own tasks carry the resolver, and they are judged where the child runs.
 */
export function fakeWriterTasks(tasks: unknown): string[] {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : []);
  const found: string[] = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const k = (task ?? {}) as { id?: unknown; resolver?: unknown; outputShapes?: unknown; output_shapes?: unknown; config?: { pointer?: { type?: unknown } } };
    const resolver = typeof k.resolver === "string" ? k.resolver : "";
    if (resolver === "compose" || resolver === "compose_parallel") continue;
    const performs = new Set([resolver, resolver.replace(/\/[^/]*$/, ""), ...(typeof k.config?.pointer?.type === "string" ? [k.config.pointer.type] : []), ...fetchedResolveWrites(task)]);
    for (const s of new Set([...list(k.outputShapes), ...list(k.output_shapes)])) {
      if ((isWriteShape(s) || isStoreWrite(s)) && !performs.has(s)) found.push(`${String(k.id ?? resolver ?? "task")}:${s}`);
    }
  }
  return found;
}

/**
 * MINT-AS-YOU-GO (the walk's bridge author): development-vessel's author_producer authors, validates and mints a thin
 * producer of `shape` around its live resolver. The minted producer and the input shapes it needs, or null on any
 * refusal (not validated, HTTP error, timeout, or the observe door), which the walk treats as no producer.
 */
export async function authorProducer(shape: string, goal: string, availableShapes: readonly string[], executionId: string | undefined, deps: ComposeDeps): Promise<{ id: string; inputShapes: string[] } | null> {
  const url = await deps.resolveUrl("author_producer");
  if (!url) return null;
  const f = sendFor("author_producer", deps);
  try {
    const r = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(deps.apiKey ? { Authorization: `ApiKey ${deps.apiKey}` } : {}) },
      body: JSON.stringify({ impulse: { type: "author_producer", pointer: { type: "author_producer", shape, goal, available_shapes: [...availableShapes], max_attempts: 3, ...(executionId ? { execution_id: executionId } : {}) } } }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (r.ok) {
      const j = (await r.json()) as Record<string, unknown>;
      const b = (j?.["body"] ?? j) as Record<string, unknown>;
      if (b?.["minted_activity_id"] && b?.["validated"]) {
        return { id: String(b["minted_activity_id"]), inputShapes: Array.isArray(b["input_shapes"]) ? (b["input_shapes"] as unknown[]).map(String) : [] };
      }
    }
  } catch { /* author failed (or refused at the door) → the walk falls through to escalate/stop */ }
  return null;
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
  const f = sendFor("activityTemplate_deprecate", deps);
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
