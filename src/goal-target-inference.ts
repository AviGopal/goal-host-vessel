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
      new Set(
        raw
          .map((s: unknown) => String(s))
          .filter((s: string) => known.has(s))
          .map((s: string) =>
            (s === "activity_create_variant" || s === "variant_promote") && known.has("activityVariant_write")
              ? "activityVariant_write"
              : s,
          ),
      ),
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

// ── INTERMEDIATE-SHAPE INFERENCE (composition, 2026-06-30) ──────────────────
// A DERIVATION goal ("analyze X THEN write the findings to note Y") is a genuine
// multi-vessel composition: an intermediate shape (analysis) must be produced
// FIRST, then its content bound into the terminal write (the note). Without this
// the walk satisfies the terminal directly from the goal text and writes a HOLLOW
// note (no real findings). This infers the intermediate shape(s) that must be
// produced BEFORE the terminal shapes, constrained to known vocabulary and
// EXCLUDING the terminals themselves.
//
// THREE REFINEMENTS over the prior (reverted) skeleton:
//   1. Bias toward `problem_detection` (real `problems[]` w/ line numbers) over
//      `code_quality` (shallow metrics the reach-gate judges hollow) for
//      analyze/review/find-problems goals.
//   2. TIGHT classifier: emit an intermediate ONLY when the goal has an explicit
//      downstream emit/write target DISTINCT from the analysis itself. A plain
//      "analyze X" (no distinct downstream sink) → [] (no composition, 1-step).
//   3. (provisioning of the real source file is handled by the existing file-path
//      arg-alias in index.ts; this module only decides the intermediate shapes.)
//
// Returns [] (no composition) on: no LLM, empty vocab, no terminals, plain
// single-step goal, parse-fail, or any error — caller falls back to the unchanged
// single-shape walk.
export interface DerivationSplit {
  /** Shapes to produce FIRST (analysis/derivation), ordered earliest-first. */
  intermediate: string[];
  /** Final emit targets to DEFER until intermediates are produced, content-bound. */
  terminal: string[];
}

// PARTITION the already-inferred target set into (intermediate-derive, terminal-emit).
// `inferGoalTargetShapes` already returns the multi-shape target for a derivation goal
// (e.g. ["problem_detection","fileWriteResult"]); the walk needs to know WHICH of those
// are the derive step (produced first) and WHICH are the terminal emit (deferred +
// content-bound from the derive output). This classifier does that split — it does NOT
// invent new shapes, only labels the ones already chosen. Empty `intermediate` (i.e.
// not a 2-stage derivation, OR only one shape) ⇒ caller does NOT defer (unchanged
// single-shape behaviour). Returns {intermediate:[], terminal:inferred} on any failure.
export async function inferDerivationSplit(
  goal: string,
  inferredTargets: string[],
  opts: InferGoalTargetShapesOpts = {},
): Promise<DerivationSplit> {
  const noSplit: DerivationSplit = { intermediate: [], terminal: inferredTargets.slice() };
  const llmEndpoint = opts.llmEndpoint;
  // A derivation needs at least 2 distinct target shapes (a derive AND an emit).
  if (!goal || !llmEndpoint || inferredTargets.length < 2) return noSplit;

  const cache = opts.cache;
  const cacheKey = `split:${goalHashOf(goal)}:${inferredTargets.slice().sort().join(",")}`;
  if (cache) {
    const cached = cache.get(cacheKey);
    // Cache stores the terminal list; reconstruct the split from it.
    if (cached) {
      const term = new Set(cached);
      return { intermediate: inferredTargets.filter((s) => !term.has(s)), terminal: cached.slice() };
    }
  }

  const known = new Set(inferredTargets);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const prompt = `A substrate GOAL has been mapped to these output impulse shapes: ${JSON.stringify(inferredTargets)}.

GOAL: ${goal}

Decide whether this is a DERIVATION/SEQUENCE goal: one that first DERIVES content (analyzes / reviews / inspects / finds problems in a source) and THEN EMITS that derived content to a DISTINCT downstream sink (writes it to a note / file / concept). If so, split the shapes:
- "intermediate": the derive/analysis shape(s) — produced FIRST (e.g. problem_detection, code_quality).
- "terminal": the emit/write shape(s) — the final sink (e.g. fileWriteResult, fs_write, concept_write) whose content should be the DERIVED findings.

RULES:
- ONLY split when the goal genuinely has TWO distinct stages (a derive stage AND a separate emit stage). If it is a PLAIN single-step goal (just analyze, or just write), return an EMPTY "intermediate" array and put ALL shapes in "terminal".
- Every shape you return MUST be from the given list — do not invent shapes.
- A shape is "terminal" if it is a write/emit/persist of the result; "intermediate" if it is the analysis/derivation whose output feeds the write.

Respond with ONLY JSON: {"intermediate": ["..."], "terminal": ["..."]}`;

  try {
    const r = await fetchImpl(`${llmEndpoint.replace(/\/$/, "")}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "llm_completion", prompt, model }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    if (!r.ok) return noSplit;
    const j: any = await r.json();
    const text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return noSplit;
    const parsed: any = JSON.parse(m[0]);
    const onlyKnown = (arr: unknown): string[] =>
      Array.isArray(arr) ? Array.from(new Set(arr.map((s) => String(s)).filter((s) => known.has(s)))) : [];
    let intermediate = onlyKnown(parsed?.intermediate);
    let terminal = onlyKnown(parsed?.terminal);
    // A shape can't be both; intermediate wins for production order, terminal for the rest.
    terminal = terminal.filter((s) => !intermediate.includes(s));
    // Any inferred shape the LLM didn't classify defaults to terminal (safe: it's a
    // target that must be produced, just not deferred-as-derived).
    for (const s of inferredTargets) if (!intermediate.includes(s) && !terminal.includes(s)) terminal.push(s);
    // A valid derivation needs BOTH a non-empty intermediate AND a non-empty terminal.
    // Otherwise it's effectively single-stage → no deferral.
    if (intermediate.length === 0 || terminal.length === 0) return noSplit;
    // REFINEMENT 1: prefer problem_detection over code_quality as the analysis
    // intermediate when both are present in the target set (substance > metrics).
    if (intermediate.includes("code_quality") && known.has("problem_detection") && !intermediate.includes("problem_detection")) {
      // Only swap if problem_detection is one of the inferred targets too; else keep.
      intermediate = intermediate.map((s) => (s === "code_quality" && known.has("problem_detection") ? "problem_detection" : s));
      terminal = terminal.filter((s) => !intermediate.includes(s));
    }
    if (cache) {
      if (cache.size >= INFER_CACHE_MAX) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(cacheKey, terminal);
    }
    return { intermediate, terminal };
  } catch {
    return noSplit;
  }
}
