/**
 * Goal→target-shape inference (lever 4, 2026-06-25).
 *
 * A natural-language goal dispatched with only {goal} (no expected_output_shapes
 * and no targetTemplateId) gives the shape-graph walk NO target, so it runs in
 * opportunistic mode and selects the highest-Thompson tick (e.g. an obsidian
 * bridge) irrespective of goal relevance — failing hollow. We seed the walk by
 * inferring the 1-3 output impulse shapes whose production would satisfy the goal,
 * reusing the verifyGoalReached LLM pattern but at the FRONT of the walk.
 *
 * The model is CONSTRAINED to the known producible-shape vocabulary (discovery's
 * advertised shapes — the set the walk can actually backward-chain / mint to), and
 * the result is filtered against that vocabulary so hallucinated shapes are dropped.
 * Returns [] on LLM-down / parse-fail / empty (caller falls back to opportunistic).
 *
 * Extracted into its own module (not inlined in index.ts) so it is unit-testable
 * without booting the vessel's HTTP server, and so `fetch` can be injected.
 */

export type FetchLike = typeof fetch;

// Stable, non-time-based hash of the goal text for caching (mirrors the goal_hash
// activity-api keys goal_execution_paths by: a deterministic digest of the goal).
// FNV-1a 32-bit. NOT Date.now()-based — same goal must map to the same key so the
// cache actually deduplicates LLM calls across retries / re-dispatches.
export function goalHashOf(goal: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < goal.length; i++) {
    h ^= goal.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const INFER_CACHE_MAX = 512;

export interface InferGoalTargetShapesOpts {
  llmEndpoint?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** In-process cache keyed by goal_hash; pass a shared Map to persist across calls. */
  cache?: Map<string, string[]>;
  model?: string;
  timeoutMs?: number;
}

/**
 * Infer the 1-3 producible output shapes that satisfy `goal`, constrained to
 * `knownShapes`. Caches by goal_hash so a second call with the same goal does not
 * re-hit the LLM. Returns [] when inference is unavailable / empty / unparseable.
 */
export async function inferGoalTargetShapes(
  goal: string,
  knownShapes: string[],
  opts: InferGoalTargetShapesOpts = {},
): Promise<string[]> {
  const llmEndpoint = opts.llmEndpoint;
  if (!goal || !llmEndpoint || knownShapes.length === 0) return [];

  const cache = opts.cache;
  const cacheKey = goalHashOf(goal);
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }

  const known = new Set(knownShapes);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const prompt = `You route a substrate GOAL to the output impulse shape(s) whose PRODUCTION would satisfy it.

GOAL: ${goal}

KNOWN producible output shapes (you MUST choose ONLY from this list — these are the shapes the substrate can actually produce):
${JSON.stringify(knownShapes)}

Return the 1-3 shapes from the KNOWN list whose production best satisfies the goal. Pick the most specific capability-matched shapes (e.g. a "find code-quality risks" goal maps to code-analysis shapes like problem_detection / code_quality, NOT to a note-writing or summary shape). If nothing in the list fits, return an empty array.

Respond with ONLY JSON: {"target_shapes": ["<shape from KNOWN list>"]}`;

  try {
    const r = await fetchImpl(`${llmEndpoint.replace(/\/$/, "")}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "llm_completion", prompt, model }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    if (!r.ok) return [];
    const j: any = await r.json();
    const text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed: any = JSON.parse(m[0]);
    const raw = Array.isArray(parsed?.target_shapes) ? parsed.target_shapes : [];
    // CONSTRAIN to the known vocabulary — drop any hallucinated shape.
    const filtered = Array.from(
      new Set(raw.map((s: unknown) => String(s)).filter((s: string) => known.has(s))),
    ).slice(0, 3) as string[];
    if (cache) {
      if (cache.size >= INFER_CACHE_MAX) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(cacheKey, filtered);
    }
    return filtered;
  } catch {
    return [];
  }
}
