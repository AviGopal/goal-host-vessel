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
const MAX_TARGET_SHAPES = 3;
 * Extracted into its own module (not inlined in index.ts) so it is unit-testable
 * without booting the vessel's HTTP server, and so `fetch` can be injected.
 */

export type FetchLike = typeof fetch;

// Stable, non-time-based hash of the goal text for caching (mirrors the goal_hash
// activity-api keys goal_execution_paths by: a deterministic digest of the goal).
// FNV-1a 32-bit. NOT Date.now()-based — same goal must map to the same key so the
// cache actually deduplicates LLM calls across retries / re-dispatches.
export function goalHashOf(goal: string): string {
  // Key on WORK, not surface form (§12.6 step 5, 2026-08-14). Coalesce TRIVIAL rephrasings — case,
  // whitespace runs, and line-wrapping — so identical work shares ONE cell instead of scattering
  // across cells keyed by surface form. NFC handles Unicode equivalence; lowercase + whitespace
  // collapse + trim strips variation that is NOT work.
  //
  // The prior form hashed the raw text AND suffixed the LINE COUNT — pure surface form — so
  // "Produce a report" and "produce  a\nreport" keyed DIFFERENT cells for identical work. This is
  // goal-host-LOCAL (inference cache, router-buffer ids, lexical-rebind donor key); activity-api
  // keys its persistent per-goal posteriors from goal_text independently, so this does NOT re-key
  // stored learning — it only sharpens local coalescing / rebind matching across rephrasings.
  const normalized = goal.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  let hash = 2166136261 >>> 0; // FNV-1a 32-bit offset basis
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = (hash * 16777619) >>> 0; // FNV prime
  }
  return hash.toString(16).padStart(8, "0");
}

const INFER_CACHE_MAX = 512;
const MAX_TARGET_SHAPES = 3;

export interface GoalTargetDecision {
  shapes: string[];
  confidence: number;
  alternatives: string[][];
}

export interface InferGoalTargetShapesOpts {
  llmEndpoint?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  maxTargetShapes?: number;
  /** In-process cache keyed by goal_hash; pass a shared Map to persist across calls. */
  cache?: Map<string, string[]>;
  model?: string;
  timeoutMs?: number;
  /**
   * Optional routed-completion hook. When provided, the LLM call is delegated to
   * this (the goal-host LLM router picks the vessel/model per task type and learns
   * from the outcome) instead of the built-in fetch. Returns the completion text,
   * or null on failure. Keeps this module testable and endpoint-agnostic.
   */
  complete?: (prompt: string) => Promise<string | null>;
  decisionCache?: Map<string, GoalTargetDecision>;
  /** Shapes the caller expects the goal to produce; when undefined, infer from goal. */
  expectedOutputShapes?: string[];
  /** A pre-pinned target template id; when provided, skip inference. */
  firstTarget?: string;
}

/**
 * Infer the 1-3 producible output shapes that satisfy `goal`, constrained to
 * `knownShapes`. When expectedOutputShapes is undefined and firstTarget is not
 * provided, this function will infer goal-satisfying shapes to seed the walk.
 * Caches by goal_hash so a second call with the same goal does not re-hit the
 * LLM. Returns [] when inference is unavailable / empty / unparseable.
 */
export async function inferGoalTargetShapes(
  goal: string,
  knownShapes: string[],
  opts: InferGoalTargetShapesOpts = {},
): Promise<string[]> {
  const llmEndpoint = opts.llmEndpoint;
  if (!goal || knownShapes.length === 0) return [];
  if (!opts.complete && !llmEndpoint) return [];

  // If caller did not provide expectedOutputShapes and no firstTarget is pinned,
  // infer the goal-satisfying output shapes from the known producible vocabulary
  // to seed the walk with goal-relevant targets instead of running opportunistically.
  // (A substrate-authored edit, 53e4267, once added an early `return []` for exactly
  // this case — the INVERSE of what this comment specifies — which turned the whole
  // function into a permanent no-op and left 5 tests red for 10 days. Typecheck
  // passed, so the autonomous verify gate never saw it. Do not reintroduce it: the
  // no-target case is the one this function exists to serve.)

  const cache = opts.cache;
  const cacheKey = goalHashOf(goal);
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }

  const known = new Set(knownShapes);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? "auto";
  // shellResult is the UNIVERSAL executor (real bash). Steer imperative / system-
  // inspection goals to it — but ONLY mention it when it is actually producible.
  // EDIT RULE — the counterweight to the worked example in the prompt.
  //
  // The prompt teaches ANALYSIS by example ("find code-quality risks" ->
  // problem_detection / code_quality) and never mentions editing. With nothing
  // pulling the other way, a REPAIR goal inherits that pull. Observed live,
  // twice, with a working model: "Fix whatever writes those records..." routed
  // to a write-bridge, and "Change that source code so..." inferred
  // ["problem_detection"] — after which the walk correctly reported "no template
  // produces the inferred target shapes" and filed a capability gap. Routing was
  // not broken; the prompt had never been told that CHANGING code is a different
  // job from INSPECTING it.
  //
  // Mentioned ONLY when an edit shape is actually producible — same discipline
  // as shellRule, so the model is never steered at a shape the substrate cannot
  // serve. This is law 8 (put the load-bearing fact where it is used), not a
  // keyword shortcut: the deterministic shortcuts elsewhere in this file each
  // return a SINGLE shape and silently drop the other half of a
  // compose-then-persist goal, which is how a truncated plan gets graded
  // "reached" while the write never happened.
  const producibleEditShapes = [
    "code_modification_proposal",
    "fs_edit",
    "fileEditResult",
    "fs_write",
    "fileWriteResult",
  ].filter((s) => known.has(s));
  const editRule = producibleEditShapes.length > 0
    ? `\n\nSPECIAL RULE — CHANGING code is not ANALYSING code. If the goal asks to CHANGE, FIX, REPAIR, IMPLEMENT, EDIT or REWRITE source code, choose an edit shape (${producibleEditShapes.join(" / ")}) — NOT an analysis shape. Analysis shapes such as problem_detection and code_quality REPORT what is wrong; they never alter the code, so a repair goal routed to one yields a finding and leaves the defect in place. Choose an analysis shape ONLY when the goal asks to find, review, audit or report rather than to alter. When a goal asks BOTH to change code and to report on it, return BOTH shapes.`
    : "";

  const shellRule = known.has("shellResult")
    ? `\n\nSPECIAL RULE — the "shellResult" shape is the UNIVERSAL EXECUTOR: producing it RUNS a real shell command. If the goal is fundamentally about RUNNING a command or INSPECTING the repo / filesystem / running system — counting, listing, "how many", "report the current", checking, or running some command X — and NO more-specific analysis / write / data-processing shape in the KNOWN list fits, choose "shellResult". Do NOT choose "shellResult" for analysis / review / note-writing / data-processing / code-edit goals that have a specific matching shape (e.g. problem_detection, code_quality, a write shape) — those are not shell jobs.`
    : "";
  const prompt = `You route a substrate GOAL to the output impulse shape(s) whose PRODUCTION would satisfy it.

GOAL: ${goal}

KNOWN producible output shapes (you MUST choose ONLY from this list — these are the shapes the substrate can actually produce):
${JSON.stringify(knownShapes)}

Return the 1-3 shapes from the KNOWN list whose production best satisfies the goal. Pick the most specific capability-matched shapes (e.g. a "find code-quality risks" goal maps to code-analysis shapes like problem_detection / code_quality, NOT to a note-writing or summary shape). If nothing in the list fits, return an empty array.${editRule}${shellRule}

Respond with ONLY JSON: {"target_shapes": ["<shape from KNOWN list>"]}`;

  try {
    let text: string;
    if (opts.complete) {
      const t = await opts.complete(prompt);
      if (t == null) return [];
      text = t;
    } else {
      const r = await fetchImpl(`${llmEndpoint!.replace(/\/$/, "")}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "llm_completion", prompt, model }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (!r.ok) return [];
      const j: any = await r.json();
      text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
    }
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
  ).slice(0, MAX_TARGET_SHAPES) as string[];
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

/**
 * Infer the goal-target shapes AND return a structured decision with confidence
 * and alternative framings. Shares the same guard clauses and vocabulary
 * filtering as inferGoalTargetShapes but returns a GoalTargetDecision.
 * Returns { shapes: [], confidence: 0, alternatives: [] } on any failure.
 */
// -- Deterministic composition-ask fallback (2026-08-13) --------------------------
// Recover a [intermediate, terminal] target for "produce/derive <named shape>, then
// persist it as a note/concept/gap" WITHOUT the LLM/concept-recall, so a
// compute-then-emit composition survives a recall/transport outage (observed: the LLM
// inferrer returns [] when concept-db is unreachable, and every such goal then gets an
// empty target and fails). PRECISION-ONLY: returns null unless BOTH a write terminal
// AND a DISTINCT known intermediate shape are named; used only where the caller would
// otherwise return an empty decision -- never preempts the richer LLM path.
const _COMPOSITION_WRITE_CLAUSE = /\b(?:write|writes|writing|save|saves|saving|record|records|recording|store|stores|storing|persist|persists|persisting|append|appends|appending|capture|captures|capturing|file)\b[^.]{0,48}?\b(?:note|notes|memory|memories|concept|concepts|document|documents|gap|gaps|journal|entry|entries|obsidian|vault)\b/i;
function _shapeToPhrase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
}
function deterministicCompositionAsk(goal: string, knownShapes: string[]): GoalTargetDecision | null {
  const wm = _COMPOSITION_WRITE_CLAUSE.exec(goal);
  if (!wm) return null;
  // WRITE_CLAUSE confirms a persist-verb + sink-noun within 48 chars. The ACTUAL sink
  // is the LAST recognised sink noun in the sentence from the write verb, so an
  // adjectival "concept-level" / "gap-severity" earlier in the window cannot hijack the
  // terminal away from the real "... in a memory note".
  const _sentence = goal.slice(wm.index, wm.index + 120).split(/[.!?]/)[0];
  const _sinkRe = /\b(note|notes|memory|memories|journal|entry|entries|document|documents|obsidian|vault|concept|concepts|gap|gaps)\b/gi;
  let _sm: RegExpExecArray | null; let _lastSink: string | null = null;
  while ((_sm = _sinkRe.exec(_sentence)) !== null) _lastSink = _sm[1].toLowerCase();
  const terminal = _lastSink == null ? null
    : /^concepts?$/.test(_lastSink) && knownShapes.includes("concept_write") ? "concept_write"
    : /^gaps?$/.test(_lastSink) && knownShapes.includes("substrateGap_write") ? "substrateGap_write"
    : knownShapes.includes("memoryNote_write") ? "memoryNote_write"
    : null;
  if (!terminal) return null;
  const excluded = new Set<string>([
    "shellResult", terminal, terminal.replace(/_write$/, ""),
    "memoryNote_write", "concept_write", "substrateGap_write", "memoryNote", "concept", "substrateGap",
  ]);
  const before = goal.slice(0, wm.index);
  let best: { shape: string; len: number } | null = null;
  for (const sh of knownShapes) {
    if (excluded.has(sh) || sh.endsWith("_write")) continue;
    const phrase = _shapeToPhrase(sh);
    if (phrase.length < 5) continue;
    const re = new RegExp(`\\b${phrase.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]+")}\\b`, "i");
    if (re.test(before) && (!best || phrase.length > best.len)) best = { shape: sh, len: phrase.length };
  }
  if (!best) return null;
  return { shapes: [best.shape, terminal], confidence: 0.8, alternatives: [] };
}
// -- Deterministic self-development env-gate route (2026-08-13) ---------------------
// A natural-language self-dev goal ("identify capabilities gated behind environment
// variables") names no shape with an ACTION verb, so _namedShape misses and the LLM
// inferrer (worked examples teach only code-analysis mapping) returns [] over ~388
// obscure names -> empty target -> opportunistic walk -> degenerate template -> 0 shapes
// (hollow; operator-observed on the "decompose failures into environmental conditions"
// goal). env_gate_scan IS advertised and self-grounding (walks the source tree, emits a
// substantive envGateReport with NO trace-store/hub dependency). Fold this into the
// `empty` value so it fires wherever inference would OTHERWISE return empty -- recall-down
// bail AND LLM-declines-[] -- covering both modes the operator observed. SCOPED to
// env_gate_scan ALONE (the one self-dev organ verified substantive without the flaky hub);
// hub-severed organs (failure_mode_summary=404, trace_*_report) are withheld until
// repaired, since routing to a severed shape hollow-greens the dispatch. !WRITE_CLAUSE so
// "save an env-gate note" keeps its compose-then-persist path; knownShapes-guarded so a
// spoke masking the producer falls through unchanged.
function deterministicEnvGateRoute(goal: string, knownShapes: string[]): GoalTargetDecision | null {
  if (!knownShapes.includes("env_gate_scan")) return null;
  if (_COMPOSITION_WRITE_CLAUSE.test(goal)) return null;
  const ENV_GATE = /\benv(?:ironment)?[\s_-]*(?:var(?:iable)?s?[\s_-]*)?gat(?:e|ed|ing)|\benv[\s_-]?gat|gated\s+behind\s+(?:an?\s+)?(?:env|environment)|\bgat(?:e|ed|ing)\b[\s\S]{0,24}\benv(?:ironment)?[\s_-]*var/i;
  if (!ENV_GATE.test(goal)) return null;
  return { shapes: ["env_gate_scan"], confidence: 0.7, alternatives: knownShapes.includes("shellResult") ? [["shellResult"]] : [] };
}
export async function inferGoalTargetDecision(
  goal: string,
  knownShapes: string[],
  opts: InferGoalTargetShapesOpts = {},
): Promise<GoalTargetDecision> {
  const empty: GoalTargetDecision = deterministicCompositionAsk(goal, knownShapes) ?? deterministicEnvGateRoute(goal, knownShapes) ?? ((/(compute|calculate|multiply|divide|sum|count|how many|number of|sort|reverse|sha-?256|hash|digest|list|report (only )?the (number|count|result|digest))/i.test(goal) && knownShapes.includes("shellResult")) ? { shapes: ["shellResult"], confidence: 0.4, alternatives: [] } : { shapes: [], confidence: 0, alternatives: [] });
  const llmEndpoint = opts.llmEndpoint;
  if (!goal || knownShapes.length === 0) return empty;
  if (!opts.complete && !llmEndpoint) return empty;

  // CACHE HANDLE HOISTED ABOVE THE SHORTCUTS, AND A SINGLE CACHING EXIT.
  //
  // `decisionCache` used to be declared BELOW the deterministic pre-LLM shortcuts,
  // so the six shortcut paths physically could not populate it — they returned a
  // real decision (confidence 0.6-0.7) and cached nothing. The only writer was the
  // slow LLM path at the bottom.
  //
  // The consequence is not a cache miss, it is a FICTIONAL COLUMN. Both readers
  // (`recordGoalPath` and the dispatch record) look the decision up by goal hash
  // and coalesce a miss to null, so every shortcut-routed goal persists
  // `inference_confidence: null`. Any analysis correlating inference confidence
  // with reach is therefore measuring a column that is absent exactly where the
  // decision was most confident — the deterministic paths.
  //
  // Routing every exit through `remember()` also makes this correct by
  // construction for shortcuts added later, which is the property the old shape
  // lacked: a new `return` above line ~386 silently reintroduced the bug.
  const decisionCache = opts.decisionCache;
  const cacheKey = goalHashOf(goal);
  const remember = (d: GoalTargetDecision): GoalTargetDecision => {
    if (decisionCache) {
      if (decisionCache.size >= INFER_CACHE_MAX) {
        const first = decisionCache.keys().next().value;
        if (first !== undefined) decisionCache.delete(first);
      }
      decisionCache.set(cacheKey, d);
    }
    return d;
  };
  {
    const cached = decisionCache?.get(cacheKey);
    if (cached) return cached;
  }

  // COMPOSITION GUARD for every deterministic pre-LLM shortcut below.
  //
  // A goal that BOTH computes a value AND asks to PERSIST it is a compute-then-emit
  // COMPOSITION, and only the LLM inferrer handles it — its COMPOSITION RULE returns
  // BOTH the producing shape and the matching write shape. Every shortcut below
  // returns a SINGLE shape, so letting one fire on a composition silently DROPS the
  // write clause. That is not a cosmetic loss: the plan becomes the truncated set,
  // the walk produces exactly it, and the reach gate — which grades against the plan
  // — declares the goal REACHED while the write never happened. Observed live: "Write
  // a memory note recording the count of TypeScript files in repos/goal-host-vessel/src"
  // planned ["shellResult"], produced ["shellResult"], reached:true, and NO note exists.
  // Plan-vs-observed reconciliation cannot catch this, because both sides agree — they
  // are both downstream of the same truncated plan.
  //
  // Each shortcut previously carried its own ad-hoc excluder (e.g.
  // `write\s+(?:a\s+)?(?:note|file|concept)`) which a single qualifier defeats:
  // "write a MEMORY note" slips through while "write a note" is caught — and the first
  // shortcut had no write exclusion at all. One shared, qualifier-tolerant detector
  // closes the class instead of patching the instance. Deliberately requires BOTH a
  // persist verb AND a persist target within a short window, so pure computes that
  // merely mention a file or report a number are NOT suppressed (the shortcuts exist
  // to stop confabulation, so over-suppressing them would regress that).
  const WRITE_CLAUSE = /\b(?:write|writes|writing|save|saves|saving|record|records|recording|store|stores|storing|persist|persists|persisting|append|appends|appending|capture|captures|capturing|file)\b[^.]{0,48}?\b(?:note|notes|memory|memories|concept|concepts|document|documents|gap|gaps|journal|entry|entries|obsidian|vault)\b/i;
  const isCompositionAsk = WRITE_CLAUSE.test(goal);

  // EXPLICITLY-NAMED SHAPE ROUTE (2026-08-05). The deterministic shortcuts below return
  // shellResult and RETURN EARLY — before the LLM inferrer, and therefore before the advertised
  // shape vocabulary is consulted at all. That is right for confabulation-prone aggregates, but
  // it also means a purpose-built shape can be correct, deployed, advertised, and never once
  // considered.
  //
  // EVIDENCE: "Run the test suite for repos/goal-host-vessel and report how many tests passed and
  // how many failed" inferred ["shellResult"] @0.6 with no alternatives — it matched the
  // FILE-SYSTEM AGGREGATE shortcut on "how many" + "repos/…". `test_suite` is advertised by
  // development-vessel, resolves correctly, is keyed to a landed sha, and appeared ZERO times in
  // 15 minutes of walk logs. Advertised and returning 200 proves a shape is REACHABLE, not
  // SELECTABLE. Left alone this silently caps every future purpose-built shape whose goals read
  // as imperative ("run", "execute", "trigger").
  //
  // The rule is driven by the SHAPE SET, not by a per-shape branch: derive each known shape's
  // English phrase from its name and honour it when the goal names it as the direct object of an
  // ACTION verb. Deliberately narrow — `run|execute|invoke|perform|trigger` immediately
  // governing the phrase. An AGGREGATE over a shape ("count open substrate gaps by category") is
  // fetch-then-transform and must KEEP its shellResult route, which this rule leaves untouched
  // because "count" is not an action verb here. shellResult is offered as the alternative, so a
  // named shape that cannot produce still falls back to the universal executor.
  const _namedShape = ((): string | null => {
    const ACTION = /\b(run|runs|execute|executes|invoke|invokes|perform|performs|trigger|triggers)\b\s+(?:the\s+|a\s+|an\s+)?([\w\s-]{3,40})/i;
    const m = ACTION.exec(goal);
    if (!m?.[2]) return null;
    const obj = m[2].toLowerCase();
    for (const s of knownShapes) {
      if (s === "shellResult") continue;                 // never let the executor match itself
      // shape name -> phrase: test_suite -> "test suite", memoryNote_write -> "memory note write"
      const phrase = s.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
      if (phrase.length < 4) continue;                   // too short to be named unambiguously
      // Allow space/hyphen/underscore between the words as the goal happens to write them.
      const re = new RegExp(`\\b${phrase.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]+")}\\b`, "i");
      if (re.test(obj)) return s;
    }
    return null;
  })();
  if (_namedShape) {
    return remember({
      shapes: [_namedShape],
      confidence: 0.8,
      alternatives: knownShapes.includes("shellResult") ? [["shellResult"]] : [],
    });
  }

  // EXPLANATORY / CONCEPTUAL PROSE-ANSWER ROUTE (D1 floor, 2026-07-26). A plain
  // "explain / what is / define / describe / how does X work / why does" question
  // has NO bespoke producer, so the LLM target-inference below COLLIDES the goal's
  // subject word onto an internal shape sharing a token ("impulse" -> poolImpulse /
  // impulseRelevance @0.95), scatters to junk satisfiers, and hollow-greens a
  // relevance TABLE. llm_completion_dispatch IS producible + dispatchable; its result
  // lands as llm_completion_result (raw prose the reach-gate judges on content). Route
  // the question straight to it, DETERMINISTICALLY, before the colliding LLM call and
  // any stale cache hit. Tight guard: explanatory lead AND no compute/fetch/analysis/
  // edit/write signal, so the shellResult / analysis / edit-intent / persist families
  // keep their own paths.
  // Hub vocab advertises raw `llm_completion` (vessel-resolvable via :8220); the
  // local substrate advertises the dispatch wrapper `llm_completion_dispatch`.
  // Fire the deterministic prose route for EITHER, targeting whichever is actually
  // in the vocabulary — so a pure question reaches instead of falling through to
  // the LLM inferrer that confabulates obsidian:write_note onto the target set.
  const _proseTarget = knownShapes.includes("llm_completion_dispatch")
    ? "llm_completion_dispatch"
    : (knownShapes.includes("llm_completion") ? "llm_completion" : null);
  if (_proseTarget) {
    const EXPLANATORY_RE = /\b(explain|describe|define|summar\w*|what\s+(is|are|does|do)\b|what'?s\b|how\s+(do|does|did|can|would|should)\b[\s\S]*\bwork|why\s+(do|does|did|is|are)\b|tell me about|walk me through|give (me )?an overview|overview of|concept of|the (idea|notion|meaning) of)\b/i;
    // A QUESTION ABOUT THE PRESENT STATE OF THE WORLD IS NOT A PROSE QUESTION (2026-08-16).
    //
    // "What is the distance from Earth to Io right now, in astronomical units?" matched
    // EXPLANATORY_RE on "what is" and nothing in NOT_PROSE_RE, so it routed to
    // llm_completion_dispatch — "ask a model" — for 45+ dispatches. But a model cannot know a
    // time-varying physical quantity: the answer is a MEASUREMENT that must be fetched, and the
    // walk had a working trust-gated fetcher (web_resource / http_response) it never reached
    // because inference had already decided the goal was definitional.
    //
    // The tell is the temporal deixis, not the subject: "right now", "currently", "today",
    // "at the moment", "as of". "What is an ephemeris" is genuinely a prose question and still
    // routes here; "what is X right now" is a retrieval question wearing a prose lead. Also
    // added: distance/position/temperature-style measurement nouns paired with a unit
    // ("in astronomical units", "in km"), which is how a request for a NUMBER announces itself.
    const NOT_PROSE_RE = /\b(count|how many|how much|number of|sum|total|bytes?|line count|lines?|digest|sha-?\d|hash|checksum|list|report the current|running|status|analy[sz]e|review|audit|problem_detection|code_quality|refactor|implement|fix|edit|patch|write (a|the)? ?(note|file|concept)|save|store|persist|fetch|download|curl|scrape|repos\/[\w.-]+\/)\b|https?:\/\//i;
    // Temporal deixis: the answer depends on WHEN it is asked, so it cannot come from weights.
    const LIVE_MEASUREMENT_RE = /\b(right now|currently|at (the|this) moment|as of (today|now)|today'?s|at present|present(ly)?|latest|current)\b|\b(distance|position|coordinates|altitude|azimuth|magnitude|velocity|temperature|price|rate)\b[\s\S]{0,60}\bin\s+(astronomical units?|au\b|km\b|kilometres?|kilometers?|miles?|degrees?|celsius|fahrenheit)/i;
    if (EXPLANATORY_RE.test(goal) && !NOT_PROSE_RE.test(goal) && !LIVE_MEASUREMENT_RE.test(goal)) {
      return remember({ shapes: [_proseTarget], confidence: 0.7, alternatives: [] });
    }
  }

  // EXTRACT-FROM-SOURCE route (2026-07-27, everyday-task floor). EVIDENCE: a live probe
  // "Read repos/.../package.json and report the value of its name field" reached HOLLOW-GREEN
  // via satisfier:fileContent — the walk resolved the RAW file read and the reach gate greened
  // because the answer is EMBEDDED in the raw content; the extraction NEVER RAN, so there was no
  // observable derived value to grade or to attach causality to. A goal that reads a NAMED
  // file/source AND asks to REPORT / GET / EXTRACT a SPECIFIC value/field/key FROM it must
  // PRODUCE the extracted value, not terminate on the raw read. shellResult is the compute that
  // jq/greps the field: routing here forces a REAL, OBSERVABLE, gradable extraction activity
  // (correctness = choosing the right extraction; causality attaches to the file operand),
  // turning a hollow read into a threaded compute over the source. TIGHT GUARD: an extract VERB
  // + a concrete config value/field NOUN + a file operand, and NOT a summarize/explain/analyze/
  // code-quality ask (those keep their prose / analysis / detection paths).
  if (knownShapes.includes("shellResult")) {
    const EXTRACT_VERB = /\b(report|extract|get|find|show|print|tell me|give me|what(?:'s| is| are)|which)\b/i;
    const VALUE_NOUN = /\b(value|field|key|version|name|entry|entries|property|properties|attribute|setting|settings|dependenc(?:y|ies)|devdependenc\w*|script|scripts|main|license|author|homepage|repository|url|port|endpoint)\b/i;
    const FILE_OPERAND = /repos\/[\w.-]+\/[\w./-]+\.\w+|\b[\w-]+\.(?:json|ts|tsx|js|jsx|md|txt|ya?ml|toml|lock|cfg|ini|sh|py|sql|env)\b/i;
    const NOT_EXTRACT = /\b(summar|explain|describe|overview|analy[sz]e|review|audit|refactor|rewrite|gist|understand|two\s+sentences?|what\s+is\s+.*\s+about|quality|problem|complexity|coverage|security|performance|architecture|conformance)\b/i;
    if (!isCompositionAsk && EXTRACT_VERB.test(goal) && VALUE_NOUN.test(goal) && FILE_OPERAND.test(goal) && !NOT_EXTRACT.test(goal)) {
      return remember({ shapes: ["shellResult"], confidence: 0.6, alternatives: [] });
    }
  }

  // REGISTRY / SYSTEM-INVENTORY COUNT route (registry-misroute, 2026-07-27). EVIDENCE: a live
  // probe "How many vessels are currently registered in the discovery registry? Report the
  // number." mis-routed to auto-bridge-source_code (produced source_code, missing shellResult)
  // — the LLM read "discovery registry" as a CODEBASE to READ rather than a LIVE system to
  // QUERY + COUNT. A COUNT/LIST over the RUNNING registry / fleet / system is answered by a real
  // curl of the discovery registry piped to a count = shellResult (the universal executor),
  // NEVER by reading source. Route DETERMINISTICALLY here (pre-LLM) so the LLM's source_code
  // guess can't win (and can't be clobbered onto the shell safety-net seed downstream). TIGHT
  // GUARD: a count/how-many ASK + a LIVE-inventory noun, and NOT an analyze/review/summarize/
  // edit/quality ask (those keep their analysis / detection / composition paths).
  if (knownShapes.includes("shellResult")) {
    const COUNT_ASK = /\b(how many|how much|number of|count|list|are there|report the (?:number|count))\b/i;
    const INVENTORY_NOUN = /\b(registr(?:y|ies|ed)|vessels?|discovery|services?|systemd|units?|containers?|processes|fleet|shapes?|resolvers?|endpoints?|ports?|advertis)\w*/i;
    const NOT_INVENTORY = /\b(analy[sz]e|review|summar|audit|refactor|edit|implement|\bfix\b|quality|problem|complexity|security|write|persist|propose|\bnote\b|concept)\b/i;
    if (!isCompositionAsk && COUNT_ASK.test(goal) && INVENTORY_NOUN.test(goal) && !NOT_INVENTORY.test(goal)) {
      return remember({ shapes: ["shellResult"], confidence: 0.6, alternatives: [] });
    }
  }

  // FILE-SYSTEM AGGREGATE route (filesystem-determinism, 2026-07-29). EVIDENCE: count/sum/
  // average/list asks over filesystem operands (files, lines, .ts/.js, repos/, src/) confabulate
  // phantom atomic shapes instead of routing to shell executors that grep/wc/find the filesystem.
  // A count/sum/average/list verb paired with a filesystem noun is deterministically answered by
  // find | wc or similar = shellResult, NEVER by source_code inference. Route here (pre-LLM) to
  // ground the executor into real filesystem queries and prevent hallucination of derived shapes.
  if (knownShapes.includes("shellResult")) {
    const FS_AGG_VERB = /\b(how many|number of|count|sum|total|average|mean|largest|biggest|smallest|longest|list|contain|containing)\b/i;
    const FS_NOUN = /\b(files?|source\s+files?|lines?|\.ts|\.js|repos\/[\w.-]+|src\/|director(?:y|ies)|folders?|codebase)\b/i;
    const NOT_FS_EDIT = /\b(implement|fix|edit|refactor|rewrite|explain|summar\w*|analy[sz]e|review|audit|propose|persist|write\s+(?:a\s+)?(?:note|file|concept))\b/i;
    if (!isCompositionAsk && FS_AGG_VERB.test(goal) && FS_NOUN.test(goal) && !NOT_FS_EDIT.test(goal)) {
      return remember({ shapes: ["shellResult"], confidence: 0.6, alternatives: [] });
    }
  }

  // SUBSTRATE-DATA AGGREGATE route (everyday-composition floor, 2026-07-29). EVIDENCE: 5/5 live
  // probes of everyday aggregates over the substrate's OWN shaped data ("count open substrateGaps
  // by category top 3", "sum failed_attempts for missing_capability gaps") CONFABULATED a phantom
  // monolithic shape (category_counts, sum_of_failed_attempts) and filed a capability gap instead
  // of THREADING the known shape through a transform. The INVENTORY_NOUN route above covers the
  // running fleet (vessels/shapes/resolvers) but EXCLUDES the substrate's DATA shapes (gaps/
  // templates/traces), so those fall through to the LLM inferrer that hallucinates an atomic
  // aggregate shape. A count/sum/group-by/rank over an advertised DATA shape is fetch-then-transform
  // = shellResult (curl the shape's read endpoint | jq the reduction) — the universal executor.
  // Route DETERMINISTICALLY here (pre-LLM) so the phantom name is never inferred; the real read
  // endpoint + jq recipe is grounded into the executor guidance (index.ts SUBSTRATE-DATA AGGREGATE).
  if (knownShapes.includes("shellResult")) {
    const AGG_VERB = /\b(count|how many|number of|sum|total|group(?:ed)? by|by category|per\s|top\s+\d|rank(?:ed)?|most\s+(?:common|frequent)|distribution|tally|average|mean)\b/i;
    const SUBSTRATE_NOUN = /\b(gaps?|substrate\s?gaps?|activity\s?templates?|activities|executions?|traces?|failed_attempts?|failure\s?modes?)\b/i;
    const NOT_AGG = /\b(implement|\bfix\b|edit|refactor|rewrite|explain|summar|analy[sz]e|review|audit|propose|persist|write\s+(?:a|the)?\s*(?:note|file|concept))\b/i;
    if (!isCompositionAsk && AGG_VERB.test(goal) && SUBSTRATE_NOUN.test(goal) && !NOT_AGG.test(goal)) {
      return remember({ shapes: ["shellResult"], confidence: 0.6, alternatives: [] });
    }
  }

  const known = new Set(knownShapes);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? "auto";
  // EDIT RULE — the counterweight to the worked example in the prompt.
  //
  // The prompt teaches ANALYSIS by example ("find code-quality risks" ->
  // problem_detection / code_quality) and never mentions editing. With nothing
  // pulling the other way, a REPAIR goal inherits that pull. Observed live,
  // twice, with a working model: "Fix whatever writes those records..." routed
  // to a write-bridge, and "Change that source code so..." inferred
  // ["problem_detection"] — after which the walk correctly reported "no template
  // produces the inferred target shapes" and filed a capability gap. Routing was
  // not broken; the prompt had never been told that CHANGING code is a different
  // job from INSPECTING it.
  //
  // Mentioned ONLY when an edit shape is actually producible — same discipline
  // as shellRule, so the model is never steered at a shape the substrate cannot
  // serve. This is law 8 (put the load-bearing fact where it is used), not a
  // keyword shortcut: the deterministic shortcuts elsewhere in this file each
  // return a SINGLE shape and silently drop the other half of a
  // compose-then-persist goal, which is how a truncated plan gets graded
  // "reached" while the write never happened.
  const producibleEditShapes = [
    "code_modification_proposal",
    "fs_edit",
    "fileEditResult",
    "fs_write",
    "fileWriteResult",
  ].filter((s) => known.has(s));
  const editRule = producibleEditShapes.length > 0
    ? `\n\nSPECIAL RULE — CHANGING code is not ANALYSING code. If the goal asks to CHANGE, FIX, REPAIR, IMPLEMENT, EDIT or REWRITE source code, choose an edit shape (${producibleEditShapes.join(" / ")}) — NOT an analysis shape. Analysis shapes such as problem_detection and code_quality REPORT what is wrong; they never alter the code, so a repair goal routed to one yields a finding and leaves the defect in place. Choose an analysis shape ONLY when the goal asks to find, review, audit or report rather than to alter. When a goal asks BOTH to change code and to report on it, return BOTH shapes.`
    : "";

  const shellRule = known.has("shellResult")
    ? `\n\nSPECIAL RULE — the "shellResult" shape is the UNIVERSAL EXECUTOR: producing it RUNS a real shell command. If the goal is fundamentally about RUNNING a command or INSPECTING the repo / filesystem / running system — counting, listing, "how many", "report the current", checking, or running some command X — and NO more-specific analysis / write / data-processing shape in the KNOWN list fits, choose "shellResult". Do NOT choose "shellResult" for analysis / review / note-writing / data-processing / code-edit goals that have a specific matching shape (e.g. problem_detection, code_quality, a write shape) — those are not shell jobs.`
    : "";
  const prompt = `You route a substrate GOAL to the output impulse shape(s) whose PRODUCTION would satisfy it.

GOAL: ${goal}

KNOWN producible output shapes (you MUST choose ONLY from this list):
${JSON.stringify(knownShapes)}

Return the 1-6 shapes from the KNOWN list whose production best satisfies the goal. Also provide a confidence value between 0 and 1 that production of the chosen shapes would actually satisfy the goal, and up to 2 ALTERNATIVE framings, each 1-6 shapes from the KNOWN list.${editRule}${shellRule}

COMPOSITION RULE — when the goal BOTH derives/produces a value AND asks to WRITE / SAVE / RECORD / STORE / PERSIST it somewhere (a note, a concept, a file), you MUST return BOTH shapes: the shape that PRODUCES the value AND the matching write/emit shape from the KNOWN list (e.g. "memoryNote_write" for a memory note, "concept_write" for a concept). This is a compute-then-emit COMPOSITION — never drop the write clause in favour of the compute alone. When the goal names MORE THAN ONE destination, return EVERY matching write/emit shape, not just one: a goal that asks to record a concept AND persist a memory note must return BOTH "concept_write" AND "memoryNote_write". Example: goal "count the lines in FILE and write the number to a memory note" -> {"target_shapes":["shellResult","memoryNote_write"]}. Example with two destinations: goal "produce a health report, record a concept capturing it, and persist a memory note stating it" -> {"target_shapes":["vessel_health_report","concept_write","memoryNote_write"]}.

Respond with ONLY JSON: {"target_shapes": [...], "confidence": 0.0, "alternatives": [[...], [...]]}`;

  try {
    let text: string;
    if (opts.complete) {
      const t = await opts.complete(prompt);
      if (t == null) return empty;
      text = t;
    } else {
      const r = await fetchImpl(`${llmEndpoint!.replace(/\/$/, "")}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "llm_completion", prompt, model }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (!r.ok) return empty;
      const j = await r.json() as Record<string, unknown>;
      const body = j?.body as Record<string, unknown> | undefined;
      text = (typeof body?.content === "string" ? body.content
        : typeof body?.text === "string" ? body.text
        : typeof j?.content === "string" ? j.content
        : "") as string;
    }
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return empty;
    const parsed = JSON.parse(m[0]) as Record<string, unknown>;
    const rawShapes = Array.isArray(parsed?.target_shapes) ? parsed.target_shapes as unknown[] : [];
    const filterShape = (s: unknown): string | null => {
      const str = String(s);
      if ((str === "activity_create_variant" || str === "variant_promote") && known.has("activityVariant_write")) {
        return "activityVariant_write";
      }
      return known.has(str) ? str : null;
    };
    const filteredShapes = Array.from(
      new Set(
        rawShapes
          .map(filterShape)
          .filter((s): s is string => s !== null),
      ),
    ).slice(0, opts.maxTargetShapes ?? 3);
    const rawConf = parsed?.confidence;
    const confidence = Math.min(1, Math.max(0,
      typeof rawConf === "number" && Number.isFinite(rawConf) ? rawConf : 0.5,
    ));
    const rawAlts = Array.isArray(parsed?.alternatives) ? parsed.alternatives as unknown[] : [];
    const primaryKey = filteredShapes.slice().sort().join(",");
    const alternatives: string[][] = [];
    for (const alt of rawAlts) {
      if (!Array.isArray(alt)) continue;
      const filteredAlt = Array.from(
        new Set(
          (alt as unknown[])
            .map(filterShape)
            .filter((s): s is string => s !== null),
        ),
      ).slice(0, 3);
      if (filteredAlt.length === 0) continue;
      if (filteredAlt.slice().sort().join(",") === primaryKey) continue;
      alternatives.push(filteredAlt);
      if (alternatives.length >= 2) break;
    }
    // FETCH+MEASURE → shellResult (deterministic override, 2026-07-25). A goal that
    // FETCHES a source AND applies a SHELL-COMPUTABLE MEASURE ("fetch <url> and count the
    // distinct tags") is mis-routed to http_fetch — a FETCH-ONLY shape that cannot compute,
    // so the satisfier produces the raw blob and the reach-gate greens a HOLLOW answer.
    // VERIFIED live: the same goal phrased "using a shell command" infers shellResult and
    // REACHES (exact count 11); phrased "fetch" infers http_fetch and hollow-greens
    // (shellResult already sits in its alternatives). shellResult is the UNIVERSAL EXECUTOR
    // — it curls AND computes in one op. Promote it over the fetch-only terminal. Never
    // fires for prose summarize/analyze/persist goals (a shell cannot do those).
    let outShapes = filteredShapes;
    // Fire whether shellResult must be PROMOTED (absent) or is already CO-PRESENT
    // alongside a fetch-only shape. The co-present case is the load-bearing one:
    // when upstream emits [http_fetch, shellResult] together, derivation-split
    // labels http_fetch an INTERMEDIATE and the walk mis-bridges it to source_code
    // (auto-bridge-source_code, universally bindable) → produces the raw shape, never
    // shellResult → hollow partial-coverage. Collapsing to [shellResult] keeps the
    // goal on the universal executor (curls AND computes in one op), as D1 proved.
    if (known.has("shellResult")) {
      const FETCH_RE = /\bhttps?:\/\/|\b(fetch|download|curl|scrape)\b/i;
      const SHELL_MEASURE_RE = /\b(count|how many|number of|distinct|unique|most (?:frequen\w*|common)|frequen\w*|occurr\w*|\bsum\b|total|bytes?\b|byte count|\blength\b|line count|longer|shorter|larger|smaller|\bcompare\b)\b/i;
      const NOT_SHELLABLE_RE = /\b(summar\w*|analy[sz]e|explain|describe|sentiment|classif\w*|translat\w*|rewrite|as a concept|store .*\bconcept\b|write .*\bnote\b)\b/i;
      const FETCH_ONLY = new Set(["http_fetch", "httpResponse", "http_response", "web_resource", "fileContent", "source_code"]);
      // LOCAL-source compute parity (ROOT A, 2026-07-26): a LOCAL-file measure goal
      // ("count the lines in file X") matches no FETCH verb, so the remote-only FETCH_RE
      // gate never fired and a confident LLM [fileContent] survived -> hollow raw read.
      // Fire ALSO when a raw local-source shape is already inferred: "wc -l <path>" is ONE
      // shell command that reads the file itself, so COLLAPSE to [shellResult] (chain=1;
      // shellResult does not consume fileContent). Same SHELL_MEASURE/!NOT_SHELLABLE guard
      // keeps pure-read and prose/write goals untouched.
      const LOCAL_SOURCE = new Set(["fileContent", "source_code"]);
      const hasLocalSource = outShapes.some((s) => LOCAL_SOURCE.has(s));
      if ((FETCH_RE.test(goal) || hasLocalSource) && SHELL_MEASURE_RE.test(goal) && !NOT_SHELLABLE_RE.test(goal) && outShapes.some((s) => FETCH_ONLY.has(s))) {
        outShapes = [...outShapes.filter((s) => !FETCH_ONLY.has(s) && s !== "shellResult"), "shellResult"];
      }
    }
    return remember({ shapes: outShapes, confidence, alternatives });
  } catch {
    return empty;
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
  if (!goal || inferredTargets.length < 2) return noSplit;
  // DETERMINISTIC SPLIT for the three emit terminals (2026-08-13): a recognised emit
  // sink + a distinct non-emit shape splits unambiguously (defer the write, produce the
  // source first) with no LLM. Scoped to exactly the sinks the composition route emits;
  // activityVariant_write is NOT one and falls through to its guard + the LLM path below.
  {
    const EMIT_TERMINALS = new Set(["memoryNote_write", "concept_write", "substrateGap_write"]);
    const emit = inferredTargets.filter((sh) => EMIT_TERMINALS.has(sh));
    const nonEmit = inferredTargets.filter((sh) => !EMIT_TERMINALS.has(sh));
    if (emit.length >= 1 && nonEmit.length >= 1 && !inferredTargets.includes("activityVariant_write")) return { intermediate: nonEmit, terminal: emit };
  }
  if (!opts.complete && !llmEndpoint) return noSplit;
  // SELF-CONTAINED terminal (2026-07-03): activityVariant_write is produced by the
  // template_repair resolver, which grounds its own analysis from the target's
  // failure traces INSIDE the resolver — it is NOT the emit-sink of a derive→emit
  // sequence. Deferring it behind LLM-guessed audit/test "intermediate" shapes it
  // never consumes lets a hollow intermediate satisfier short-circuit the reach
  // verdict before the real variant is minted. A repair goal is single-stage.
  if (inferredTargets.includes("activityVariant_write")) return noSplit;

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
  const model = opts.model ?? "auto";
  const prompt = `A substrate GOAL has been mapped to these output impulse shapes: ${JSON.stringify(inferredTargets)}.

GOAL: ${goal}

Decide whether this is a DERIVATION/SEQUENCE goal: one that first reads/derives from a SOURCE and THEN produces a DISTINCT deliverable from it. The deliverable (terminal) may be either (a) an EMIT to a downstream sink (writes the derived content to a note / file / concept), or (b) a derived/extracted/computed VALUE returned inline (e.g. a count, an extracted field, a shell-computed number). If so, split the shapes:
- "intermediate": the RAW SOURCE read or analysis shape(s) produced FIRST as the MEANS of the derivation (e.g. fileContent, source_code, codeReadResult, problem_detection, code_quality).
- "terminal": the DELIVERABLE shape(s) — the goal's actual answer, whether an emit/write sink (e.g. fileWriteResult, fs_write, concept_write) OR a derived/extracted/computed value (e.g. json_path_extract, shellResult) — whose content is the DERIVED result.

RULES:
- ONLY split when the goal genuinely has TWO distinct stages (a read/derive stage AND a separate deliverable stage). If it is a PLAIN single-step goal (just read, or just write), return an EMPTY "intermediate" array and put ALL shapes in "terminal".
- Every shape you return MUST be from the given list — do not invent shapes.
- A RAW SOURCE read (fileContent, source_code, codeReadResult) is the MEANS of a derivation, never the deliverable: put it in "intermediate" whenever any other shape is present. A shape is "terminal" if it is the write/emit sink OR the derived/computed value the goal asks for.

Respond with ONLY JSON: {"intermediate": ["..."], "terminal": ["..."]}`;

  try {
    let text: string;
    if (opts.complete) {
      const t = await opts.complete(prompt);
      if (t == null) return noSplit;
      text = t;
    } else {
      const r = await fetchImpl(`${llmEndpoint!.replace(/\/$/, "")}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "llm_completion", prompt, model }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (!r.ok) return noSplit;
      const j: any = await r.json();
      text = j?.body?.content ?? j?.content ?? j?.body?.text ?? "";
    }
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
    // DERIVE-AND-RETURN INVERSION GUARD (2026-07-26, law 8): the prompt recognizes
    // both emit-to-sink and derived-value deliverables, but the split is a
    // NON-DETERMINISTIC LLM call that can still invert — labeling the raw source read
    // (fileContent/source_code/codeReadResult) as "terminal" and the derived answer as
    // "intermediate", so the reach gate greens on the raw input. Encode the load-bearing
    // fact deterministically: a raw-source read is the MEANS of a derivation, never its
    // deliverable, whenever any non-raw target shape exists.
    const RAW_SOURCE_SHAPES = new Set(["fileContent", "source_code", "codeReadResult"]);
    if (inferredTargets.some((s) => !RAW_SOURCE_SHAPES.has(s))) {
      const rawInTerminal = terminal.filter((s) => RAW_SOURCE_SHAPES.has(s));
      if (rawInTerminal.length > 0) {
        terminal = terminal.filter((s) => !RAW_SOURCE_SHAPES.has(s));
        for (const s of rawInTerminal) if (!intermediate.includes(s)) intermediate.push(s);
        // If demotion emptied terminal, the derived shapes the LLM buried in
        // intermediate ARE the deliverable — promote them.
        const derivedInIntermediate = intermediate.filter((s) => !RAW_SOURCE_SHAPES.has(s));
        if (terminal.length === 0 && derivedInIntermediate.length > 0) {
          terminal = derivedInIntermediate.slice();
          intermediate = intermediate.filter((s) => RAW_SOURCE_SHAPES.has(s));
        }
      }
    }
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
