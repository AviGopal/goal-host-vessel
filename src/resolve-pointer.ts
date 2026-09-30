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
  return { ...pool, ...args, type: shape };
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
