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
