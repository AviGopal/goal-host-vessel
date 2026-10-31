/**
 * The pointer a walk resolves: the pool defaults, then the synthesized args, and the SHAPE LAST.
 *
 * rawResolve built `{ type: shape, ...base, ...extraArgs }`, so a synthesized arg could override the shape being
 * resolved. On 2026-09-30 the arg synthesizer returned type "http_fetch" for a web_search step (its prompt says not
 * to add a type key, but nothing removed one), local-tools answered 404 "no resolver for 'http_fetch'", and every
 * "what is happening today" goal fell through to model-memory filler graded HOLLOW. The shape is the walk's
 * decision, never the synthesizer's: a synthesized `type` is dropped, and `type` is set last.
 */
export function buildResolvePointer(
  shape: string,
  base: Record<string, unknown>,
  extraArgs: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const { type: _synthesizedType, ...args } = (extraArgs ?? {}) as Record<string, unknown>;
  const { type: _baseType, ...pool } = base ?? {};
  return stripEndpointOverrides(shape, stripOperatorMarker(shape, { ...pool, ...args, type: shape }));
}

/** A shape whose resolve MUTATES a store: the `_write` suffix family plus the vault note write. */
export function isStoreWriteShape(shape: string): boolean {
  return /_write$/.test(shape) || /(^|:)write_note$/.test(shape);
}

/**
 * NO WALK-BUILT WRITE CARRIES AN OPERATOR MARKER.
 *
 * The gap store accepts `operator: "operator:<id>"` on a write pointer as the mark of an
 * operator's hand, and it lets that write past its hold and close-evidence guards. Every pointer
 * built here comes from pool variables plus synthesized args (the arg-correction merge, and the
 * action and action-retry picks, are LLM output passed through verbatim). An operator's own
 * writes come from the cockpit straight to the owning vessel and never pass through here. So an
 * `operator` key on a write pointer built here is a spoof by construction, at any depth: on the
 * pointer, under the written record (gap.operator), or under a nested impulse.pointer. It is
 * dropped, the same way the reach judge's `deterministic` claim is forced false. A non-write
 * pointer is returned unchanged, because `operator` can be an ordinary query field there.
 * The input is never mutated.
 */
export function stripOperatorMarker<T extends Record<string, unknown>>(shape: string, obj: T): T {
  if (!isStoreWriteShape(shape)) return obj;
  const strip = (v: unknown, depth: number): unknown => {
    if (depth > 8 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "operator") continue;
      out[k] = strip(x, depth + 1);
    }
    return out;
  };
  return strip(obj, 0) as T;
}

/** A field name that can redirect where the owning vessel sends a request: ends with Url, Endpoint,
 *  _url or _endpoint, any case (the bare names `url` and `endpoint` included). */
export const ENDPOINT_OVERRIDE_KEY = /(url|endpoint)$/i;

/** A field name that carries a credential: ends with api_key / apiKey / apikey / token, any case. The model
 *  never supplies credentials; a vessel's own keys come from its environment. */
export const CREDENTIAL_KEY = /(api_?key|apikey|token)$/i;

/**
 * URL AS DATA. The shapes whose contract takes a URL as their INPUT, not as a place to send a request
 * on someone's behalf, and the one field that carries it. Each was checked against its resolver:
 *   http_fetch     development-vessel resolvers/http-fetch.ts     pointer.url is the URL fetched
 *   http_response  development-vessel resolvers/http-response.ts  pointer.url (delegates to web_resource)
 *   web_resource   development-vessel resolvers/web-resource.ts   pointer.url (trust-gated fetch)
 * plus the camelCase shape names the walk uses for the same producers (httpResponse, webResource).
 * No resolver_schema contract (development-vessel, concept-db) lists any other url / endpoint input.
 * Adding a shape here is a deliberate decision: it lets the walk name that shape's URL.
 */
export const URL_AS_DATA: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["http_fetch", new Set(["url"])],
  ["http_response", new Set(["url"])],
  ["httpResponse", new Set(["url"])],
  ["web_resource", new Set(["url"])],
  ["webResource", new Set(["url"])],
]);

/**
 * CREDENTIAL-NAMED FIELD AS DATA. The credential strip's counterpart to URL_AS_DATA: a shape whose resolver takes a
 * field that matches CREDENTIAL_KEY as its own contract input, which is not a node credential. Each is checked against
 * its resolver:
 *   maintenanceLease_write  development-vessel resolvers/maintenance-lease.ts  pointer.token is the lease handle that
 *                           acquire returned (renew/release take it; it is validated against the lease file, so a wrong
 *                           one is token_mismatch). Stripping it failed every trace-store reconcile at its release.
 * Adding a shape here is a deliberate decision, as for URL_AS_DATA.
 */
export const CREDENTIAL_AS_DATA: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["maintenanceLease_write", new Set(["token"])],
]);

/**
 * NO WALK-BUILT POINTER CARRIES AN ENDPOINT OVERRIDE OR A CREDENTIAL.
 *
 * Several vessels attach their node key to fetch URLs that a resolve pointer field can override
 * (development-vessel's devVesselImpulsesUrl / obsidianEndpoint, llm-resolver's
 * tool_dispatch_endpoint, and more). Every pointer built here is walk-built by construction (pool
 * variables plus synthesized args, the LLM's output passed through verbatim; see stripOperatorMarker).
 * So on EVERY shape (2e233b5 covered store writes only), these fields are dropped, at the top level and
 * one level into a `pointer` or `impulse` object (so impulse.pointer too):
 *   - a field whose name matches ENDPOINT_OVERRIDE_KEY, except a URL_AS_DATA shape's own URL field;
 *   - a field whose name matches CREDENTIAL_KEY.
 * A deeper field (a written record's own data, such as gap.evidence_url) is left alone. One line names
 * the dropped fields, never their values. The input is never mutated.
 *
 * An operator's pointer never passes here: the cockpit and the inbound resolve routes send it to the
 * owning vessel directly, and templates resolve their task configs in the executor, not through the walk.
 */
export function stripEndpointOverrides<T extends Record<string, unknown>>(shape: string, obj: T): T {
  const dataFields = URL_AS_DATA.get(shape);
  const credDataFields = CREDENTIAL_AS_DATA.get(shape);
  const dropped: string[] = [];
  const isPlain = (v: unknown): v is Record<string, unknown> => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };
  const strip = (o: Record<string, unknown>, path: string, nestLeft: number, top: boolean): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      const atPointer = top || path === "impulse.pointer." || path === "pointer.";
      const urlAsData = dataFields?.has(k) === true && atPointer;
      const credAsData = credDataFields?.has(k) === true && atPointer;
      if ((ENDPOINT_OVERRIDE_KEY.test(k) && !urlAsData) || (CREDENTIAL_KEY.test(k) && !credAsData)) { dropped.push(path + k); continue; }
      out[k] = nestLeft > 0 && (k === "pointer" || k === "impulse") && isPlain(v) ? strip(v, `${path}${k}.`, nestLeft - 1, false) : v;
    }
    return out;
  };
  const out = strip(obj, "", 2, true);
  if (dropped.length) console.warn(`[goal-host] endpoint-override strip: walk-built ${shape} dropped ${dropped.join(", ")}`);
  return out as T;
}

/**
 * The pointer a model-requested tool call resolves: caller defaults, then the model's args, then extras (the
 * dispatch id), and the tool's own shape LAST. ufExecuteTool built `{ type: name, ...defaults, ...args, ...extras }`,
 * so a model-written `type` in the args changed what the owning vessel was asked to resolve while the call was
 * routed by name (2026-09-30; the same class buildResolvePointer closed for the walk, and llm-resolver's
 * dispatchTool closed for its tool loop). A `type` in args or extras is dropped.
 */
export function toolPointer(
  name: string,
  args: Record<string, unknown> | null | undefined,
  extras: Record<string, unknown>,
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  const { type: _extraType, ...rest } = extras ?? {};
  return buildResolvePointer(name, defaults, { ...(args ?? {}), ...rest });
}

/**
 * Is this impulse content ONLY execution bookkeeping?
 *
 * Task #59, 2026-08-10. The reach digest is built from any impulse whose content
 * is non-null, then handed to the gate as evidence the goal was answered. A stub
 * carrying nothing but `{producedBy, executionId}` serialises to a plausible
 * string and counts — so a report goal is graded REACHED on a receipt for work
 * that produced no report.
 *
 * This tests for the ABSENCE of substance, not the presence of known-bad keys: a
 * whitelist of "bookkeeping" names would be defeated by the next field someone
 * adds. An object whose every key is provenance metadata has no payload, however
 * many such keys it carries.
 *
 * Deliberately narrow. Only objects are judged; a string, a number or an array
 * is content by construction and is left alone. An object with even ONE
 * non-bookkeeping key passes, because partial content is still content and the
 * substance gate downstream is what judges quality.
 */
export function isBookkeepingOnly(content: unknown): boolean {
  if (typeof content !== "object" || content === null || Array.isArray(content)) return false;
  const keys = Object.keys(content as Record<string, unknown>);
  if (keys.length === 0) return true; // {} carries nothing at all
  const BOOKKEEPING = new Set([
    "producedBy", "produced_by", "executionId", "execution_id", "traceId", "trace_id",
    "activityId", "activity_id", "templateId", "template_id", "dispatchId", "dispatch_id",
    "timestamp", "created_at", "createdAt", "shape", "type", "id", "version",
  ]);
  return keys.every((k) => BOOKKEEPING.has(k));
}

/** One field of a producer's resolver_schema contract. `synthesize_from` is the producer's own declaration of how a missing
 *  value may be made from what the walk holds: "goal_and_upstream", or the list of its sources (["goal", "upstream"], either
 *  alone). A field without one is never synthesized, whatever it is called. */
export type RequiredInputField = { name: string; required?: boolean; type?: string; synthesize_from?: string | ReadonlyArray<string> };
/** The owning vessel's resolver_schema answer: { shape, known, envelope?, fields }. */
export type RequiredInputContract = { shape?: string; known?: boolean; envelope?: string; fields?: ReadonlyArray<RequiredInputField> };
export type RequiredInputDecision =
  | { invoke: true; pointer: Record<string, unknown>; synthesized: string[] }
  | { invoke: false; reason: string; missing: string[] };

/** The one synthesis a contract can declare today: the goal text plus the step's bound upstream content. */
export const SYNTHESIZE_FROM_GOAL_AND_UPSTREAM = "goal_and_upstream";
/** The sources a list-form synthesize_from may name. */
const SYNTHESIS_SOURCES: ReadonlySet<string> = new Set(["goal", "upstream"]);
/** The sources a field's synthesize_from declares, or null when it declares none this gate can honour. */
function synthesisSources(s: unknown): { goal: boolean; upstream: boolean } | null {
  if (s === SYNTHESIZE_FROM_GOAL_AND_UPSTREAM) return { goal: true, upstream: true };
  if (!Array.isArray(s) || s.length === 0 || !s.every((x) => typeof x === "string" && SYNTHESIS_SOURCES.has(x))) return null;
  return { goal: s.includes("goal"), upstream: s.includes("upstream") };
}
/** Upstream content threaded into a synthesized input is cut at this many characters. */
const SYNTHESIZED_UPSTREAM_CAP = 120_000;

const isBoundValue = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === "string" && v.trim().length === 0);
const isPlainRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The goal, then every bound upstream content that is not bookkeeping (isBookkeepingOnly), each under its shape. Empty
 *  when there is neither a goal nor any content: nothing to synthesize from. */
function goalAndUpstreamText(goal: string, upstream: ReadonlyArray<{ metadata?: { shape?: string }; content?: unknown }>): string {
  const g = (goal ?? "").trim();
  const parts: string[] = [];
  for (const imp of upstream ?? []) {
    const c = imp?.content;
    if (c === undefined || c === null || isBookkeepingOnly(c)) continue;
    let text: string;
    try { text = typeof c === "string" ? c : JSON.stringify(c); } catch { continue; }
    if (!text || !text.trim() || text.trim() === g) continue;
    const sh = imp?.metadata?.shape;
    parts.push(sh ? `[${sh}]\n${text}` : text);
  }
  if (parts.length === 0) return g;
  const up = parts.join("\n\n").slice(0, SYNTHESIZED_UPSTREAM_CAP);
  return g ? `${g}\n\n--- BOUND UPSTREAM INPUTS ---\n${up}` : up;
}

/**
 * A PRODUCER'S REQUIRED INPUTS ARE BOUND BEFORE THE WALK INVOKES IT.
 *
 * Measured 2026-10-03: the walk ran a learned template for a dispatch shape whose producer requires an input that nothing
 * in the pool or the task config named, the pointer went out without it, the producer refused before doing any work, and
 * the template was graded failed on every execution. The rule is a binding contract, never a per-shape case: for each
 * field the producer's resolver_schema answer marks `required`, the pointer either
 *   (a) already binds it (defined, non-null, not a blank string; under the contract's `envelope` when it has one), or
 *   (b) gets it SYNTHESIZED, when the field declares `synthesize_from` ("goal_and_upstream", or a list of the sources
 *       "goal" / "upstream") and those sources hold a goal or bound upstream content to make it from, or
 *   (c) is NOT invoked: the decision names every unbindable field ("unbindable required input: <name>").
 * A contract that is absent, unknown (known:false) or carries no field list cannot be judged, and the pointer is invoked
 * as built. The input pointer is never mutated; a synthesized pointer is a copy with the synthesized fields added.
 */
export function bindRequiredInputs(a: {
  shape: string;
  pointer: Record<string, unknown>;
  contract: RequiredInputContract | null | undefined;
  goal: string;
  upstream: ReadonlyArray<{ metadata?: { shape?: string }; content?: unknown }>;
}): RequiredInputDecision {
  const { pointer, contract } = a;
  if (!contract || contract.known !== true || !Array.isArray(contract.fields)) return { invoke: true, pointer, synthesized: [] };
  const env = typeof contract.envelope === "string" ? contract.envelope.trim() : "";
  const holder: Record<string, unknown> = env ? (isPlainRecord(pointer[env]) ? pointer[env] as Record<string, unknown> : {}) : pointer;
  const fill: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of contract.fields) {
    if (!f || f.required !== true || typeof f.name !== "string" || f.name.length === 0) continue;
    if (isBoundValue(holder[f.name])) continue;
    const from = synthesisSources(f.synthesize_from);
    if (from) {
      const text = goalAndUpstreamText(from.goal ? a.goal : "", from.upstream ? a.upstream : []);
      if (text.trim().length > 0) { fill[f.name] = text; continue; }
    }
    missing.push(f.name);
  }
  if (missing.length > 0) return { invoke: false, reason: `unbindable required input: ${missing.join(", ")} (${a.shape})`, missing };
  const synthesized = Object.keys(fill);
  if (synthesized.length === 0) return { invoke: true, pointer, synthesized };
  return { invoke: true, pointer: env ? { ...pointer, [env]: { ...holder, ...fill } } : { ...pointer, ...fill }, synthesized };
}
