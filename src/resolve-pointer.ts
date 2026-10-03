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
  const dropped: string[] = [];
  const isPlain = (v: unknown): v is Record<string, unknown> => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };
  const strip = (o: Record<string, unknown>, path: string, nestLeft: number, top: boolean): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      const urlAsData = dataFields?.has(k) === true && (top || path === "impulse.pointer." || path === "pointer.");
      if ((ENDPOINT_OVERRIDE_KEY.test(k) && !urlAsData) || CREDENTIAL_KEY.test(k)) { dropped.push(path + k); continue; }
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
