/**
 * VERBATIM FILE-READ ORACLE — "read <abs path> and tell me exactly what it says".
 *
 * MEASURED 2026-10-01 (dispatches ee3cdfc3 standalone, e8cd543b spoke): step 1 resolved
 * fileContent for the named path and returned the file's exact bytes. The LLM reach judge
 * called that HOLLOW ("truncated", "partial information"), which drove a FEEDBACK-RETRY of the
 * same chain (hollow again), suppression of the producer that worked, and a retry WIDENED to
 * shellResult/httpResponse/webSearchResult — a web search for a local file path. 35 walk-log
 * entries, reached:false, for an answer the walk had after one step.
 *
 * Instructing the judge in prose was tried for this class of error and did not hold (8a85cfa,
 * 2c26fcb). What held was a deterministic check in front of it (f44b27b). This is one more entry
 * in the reach gate's oracle chain (verifyGoalReached), with the sibling oracles' contract:
 * a verdict when it can grade, `null` (abstain → the next oracle / the LLM judge) otherwise.
 *
 * INDEPENDENCE. In the measured walk the pool held only the fileContent, so the delivered answer
 * IS the producer's read. Comparing it to itself would be a format check, and a format check must
 * never overturn a hollow verdict. So ground truth is a FRESH re-read of the same path through the
 * same producer shape (fileContent, routed by discovery like the walk's own resolve), and the walk
 * is reached only when something it delivered carries that fresh content. When the re-read is not
 * available, the only honest comparison left is a separate answer text (e.g. an LLM restatement)
 * against the walk's own producer read; with no such text the oracle abstains.
 *
 * DECLINE WHAT THE PARSE CANNOT REPRESENT. The family is a positive phrase list plus exactly one
 * absolute path, with transformation words (count, summarize, line N, grep, write, compare, …)
 * excluded. Anything else abstains, so the existing judge sees it unchanged.
 */

export interface GoalReachVerdictLike {
  reached: boolean;
  reason: string;
  completion_shapes: string[];
  deterministic?: boolean;
}

/** A producer read: the content, plus what the producer itself says about completeness. */
export interface FileRead {
  path: string | null;
  content: string;
  /** Producer-declared full size in bytes, when it reports one (development-vessel fs_read). */
  bytes?: number;
  /** Producer-declared truncation (fs_read byteLimit). */
  truncated?: boolean;
}

/** Re-read `path` through the fileContent producer. null = unavailable (never throws). */
export type Reread = (path: string) => Promise<FileRead | null>;

// Phrasings that ask for the file's literal contents. Each needs exactly one absolute path in the
// goal (checked separately). Deliberately narrow: "tell me what it says" alone is not on the list.
const VERBATIM_CUES: RegExp[] = [
  /\bexactly what (?:it|the file|this file|that file)\s+(?:says|contains|reads)\b/,
  /\bwhat (?:it|the file)\s+says,? exactly\b/,
  /\bverbatim\b/,
  /\bword[- ]for[- ]word\b/,
  /\b(?:exact|full|entire|complete|raw|whole)\s+(?:contents?|text|bytes)\b/,
  /\b(?:print|cat|show|display|output|dump|return|give)\s+(?:me\s+)?(?:the\s+)?(?:(?:full|entire|exact|raw|whole|complete)\s+)?(?:contents?|text)\s+of\b/,
];

// Anything that asks for more or other than the bytes: a derived value, a part of the file, an
// edit, or a second task. Matched against the goal with the path REMOVED (a path like
// /x/data.json must not trip "json").
const NOT_VERBATIM =
  /\b(?:summar\w*|count\w*|how many|number of|lines?\s+\d+|first\s+\d+|last\s+\d+|head|tail|grep|search\w*|find|explain\w*|translat\w*|pars\w*|extract\w*|field|key|value of|json|yaml|write|writ\w+|edit\w*|chang\w+|modif\w+|append\w*|replac\w+|delet\w+|remov\w+|creat\w+|compar\w+|diff\w*|between|then|also|plus|word count|length|size|checksum|hash|sha|md5|base64|encod\w+|decod\w+|why|meaning|mean|investigat\w*|decompos\w*|gap|fix\w*|add|insert\w*|anchor|implement\w*|close|apply|make|wire|patch\w*|refactor\w*|rename\w*|move|copy|run|execute|install)\b/;

const ABS_PATH = /(?:^|[\s"'`(\[<])(\/(?:[\w.@+-]+\/)*[\w.@+-]+)/g;

function normPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

/**
 * The absolute path whose verbatim contents the goal asks for, or null (not this family).
 * Exactly one distinct absolute path; trailing sentence punctuation is not part of it.
 */
export function verbatimReadTarget(goal: string): string | null {
  // A request for a file's bytes is one short sentence or two. Long goals are task specs that
  // QUOTE text "verbatim" (edit anchors, gap repairs) — measured against the label corpus, the
  // first matcher claimed a 1.6KB edit goal whose regex literal "(/restarted …" read as a path.
  if (goal.length > 300) return null;
  const g = goal.toLowerCase();
  if (!VERBATIM_CUES.some((re) => re.test(g))) return null;
  if (/\brepos\//.test(g)) return null;
  const paths = new Set<string>();
  for (const m of goal.matchAll(ABS_PATH)) {
    const raw = (m[1] ?? "").replace(/[.,;:!?]+$/, "");
    if (raw.length > 1) paths.add(normPath(raw));
  }
  if (paths.size !== 1) return null;
  const path = [...paths][0]!;
  // A file path, not a bare token after a slash ("/restarted", "/i"): at least two segments.
  if (path.split("/").filter(Boolean).length < 2) return null;
  const withoutPaths = goal.replace(ABS_PATH, " ").toLowerCase();
  if (NOT_VERBATIM.test(withoutPaths)) return null;
  return path;
}

/** Extract a producer read from any of the fileContent envelopes the fleet emits. */
export function fileReadOf(v: unknown): FileRead | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  // local-tools: {shape, path, content}; development-vessel fs_read: {shape, body:{path, bytes,
  // content, truncated}}; a resolve envelope may wrap either under `content` or `body`.
  if (typeof o["content"] === "string") {
    if (o["error"] !== undefined) return null;
    return {
      path: typeof o["path"] === "string" ? o["path"] : null,
      content: o["content"] as string,
      ...(typeof o["bytes"] === "number" ? { bytes: o["bytes"] as number } : {}),
      ...(o["truncated"] === true ? { truncated: true } : {}),
    };
  }
  for (const k of ["body", "content", "result"]) {
    const inner = fileReadOf(o[k]);
    if (inner) return inner;
  }
  return null;
}

interface DigestEntry { shape: string; text: string }

/** Split a reach digest ("- <shape>: <content>" entries, content possibly multi-line). */
export function digestEntries(dig: string): DigestEntry[] {
  const out: DigestEntry[] = [];
  for (const chunk of dig.split(/\n(?=- [A-Za-z_][\w:.-]*: )/)) {
    const m = chunk.match(/^- ([A-Za-z_][\w:.-]*): ([\s\S]*)$/);
    if (m) out.push({ shape: m[1]!, text: m[2]! });
  }
  return out;
}

function stringLeaves(v: unknown, acc: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof v === "string") { acc.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) stringLeaves(x, acc, depth + 1); return; }
  if (v && typeof v === "object") for (const x of Object.values(v)) stringLeaves(x, acc, depth + 1);
}

const FETCHED_ELSEWHERE = new Set(["webSearchResult", "web_search", "httpResponse", "http_response", "http_fetch", "httpStatusCode", "json_extracted_value"]);

// Bookkeeping shapes the pool always carries; never an answer.
const BOOKKEEPING = new Set(["goal", "dispatch_id"]);

/**
 * Normalisation: CRLF→LF and trim the ends. Nothing inside is touched — this is an EXACT-content
 * family. Trimming the ends is needed because a file's trailing newline is invisible in any prose
 * answer ("latency-probe-…-42\n" is correctly reported as "latency-probe-…-42"), and a leading/
 * trailing blank cannot change what the file says.
 */
export function normText(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

/** Strip one layer of a code fence or matching quotes around an answer (for prefix detection). */
export function unwrapAnswer(s: string): string {
  let t = normText(s);
  const fence = t.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  if (fence) return normText(fence[1]!);
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ["`", "`"], ["“", "”"], ["‘", "’"]];
  for (const [a, b] of pairs) {
    if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) { t = normText(t.slice(a.length, t.length - b.length)); break; }
  }
  return t;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

const SHORT_TRUTH_FLOOR = 12;

type Compare = { kind: "carries" } | { kind: "prefix"; n: number } | { kind: "other" };

function compare(candidates: string[], truth: string): Compare {
  const t = normText(truth);
  let best = 0;
  // A SHORT truth ("42", "ok") is contained by accident in unrelated pool text (a search snippet,
  // a sentence), which would certify a wrong read as reached. Below the floor, only an answer that
  // IS the content (after unwrapping one fence/quote pair) carries it.
  const short = t.length < SHORT_TRUTH_FLOOR;
  for (const c of candidates) {
    if (short ? unwrapAnswer(c) === t : normText(c).includes(t)) return { kind: "carries" };
    const u = unwrapAnswer(c);
    if (u.length > 0 && u.length < t.length && t.startsWith(u)) best = Math.max(best, bytes(u));
  }
  return best > 0 ? { kind: "prefix", n: best } : { kind: "other" };
}

/**
 * The oracle. Returns a verdict, or null to abstain (next oracle / the LLM judge decides).
 */
export async function verifyVerbatimFileRead(
  goal: string,
  dig: string,
  reread: Reread | null,
  /** Told WHY an in-family goal abstained, when the reason is worth a log line (e.g. a changed file). */
  noteAbstain?: (reason: string) => void,
): Promise<GoalReachVerdictLike | null> {
  const path = verbatimReadTarget(goal);
  if (!path) return null;

  const entries = digestEntries(dig ?? "");
  const reads: FileRead[] = [];
  const answers: string[] = [];
  for (const e of entries) {
    if (BOOKKEEPING.has(e.shape)) continue;
    if (e.shape === "fileContent") {
      let parsed: unknown;
      try { parsed = JSON.parse(e.text); } catch {
        // A raw-string fileContent has no path, and a JSON one cut by the digest caps cannot be
        // read — either way the walk's read for this path cannot be identified. Abstain rather
        // than let a cap artefact become "wrong file" or "truncated".
        return null;
      }
      const fr = fileReadOf(parsed);
      if (fr) { reads.push(fr); continue; }
      // A provenance stub ({producedBy, executionId}) carries no content: not a read.
      continue;
    }
    // Content fetched from ELSEWHERE (the web, an HTTP endpoint) is not an answer composed for this
    // goal; counting it would turn an incidental search snippet into a "wrong answer". A denylist,
    // not an allowlist: the answer vocabulary is open (llmTextCompletion, shellResult stdout, …).
    if (FETCHED_ELSEWHERE.has(e.shape)) continue;
    let parsed: unknown = undefined;
    try { parsed = JSON.parse(e.text); } catch { /* raw text */ }
    if (parsed !== undefined && typeof parsed !== "string") {
      const leaves: string[] = [];
      stringLeaves(parsed, leaves);
      answers.push(...leaves);
    } else {
      answers.push(typeof parsed === "string" ? parsed : e.text);
    }
  }

  // No producer read in the pool at all: nothing to grade against. Abstain.
  if (reads.length === 0) return null;

  const forPath = reads.filter((r) => r.path !== null && normPath(r.path) === path);
  if (forPath.length === 0) {
    const others = reads.filter((r) => r.path !== null).map((r) => normPath(r.path!));
    const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
    // Wrong file only when every read names a file with a DIFFERENT basename; a same-basename read
    // under another root may be a producer-side path mapping, which this oracle cannot judge.
    if (others.length > 0 && others.length === reads.length && others.every((p) => base(p) !== base(path))) {
      return {
        reached: false,
        reason: `deterministic:verbatim-read-wrong-file — the goal asks for ${path} but the walk read ${[...new Set(others)].join(", ").slice(0, 200)}`,
        completion_shapes: [],
      };
    }
    return null;
  }

  // The producer itself declared it did not return the whole file.
  for (const r of forPath) {
    const declaredShort = r.truncated === true || (typeof r.bytes === "number" && r.bytes > bytes(r.content));
    if (declaredShort) {
      return {
        reached: false,
        reason: `deterministic:verbatim-read-truncated — truncated: ${bytes(r.content)} of ${r.bytes ?? "?"} bytes (the fileContent producer reported a partial read of ${path})`,
        completion_shapes: [],
      };
    }
  }

  // Ground truth: a fresh read through the same producer shape.
  //
  // WHAT THIS CAN AND CANNOT CATCH. The re-read goes through the SAME fileContent producer the walk
  // used, so a systematic producer error (wrong encoding, a mapped root pointing at the wrong tree,
  // a silent cap) is reproduced by the re-read and confirms itself — a channel's own reporting is
  // not evidence about the channel. This oracle catches fabrication (an answer the file does not
  // carry), truncation, and nondeterminism between reads; it does not catch producer bugs. The
  // re-read-path == goal-path check below is the partial guard (a producer that answers for some
  // other file is refused as ground truth).
  let fresh: FileRead | null = null;
  if (reread) {
    try { fresh = await reread(path); } catch { fresh = null; }
    if (fresh && fresh.path !== null && normPath(fresh.path) !== path) fresh = null;
    if (fresh && (fresh.truncated === true || (typeof fresh.bytes === "number" && fresh.bytes > bytes(fresh.content)))) fresh = null;
  }

  // The walk's own reads of the path (walk_read), and what it DELIVERED: a separate answer text when
  // the walk composed one, otherwise the read itself is the answer.
  const walkReads = forPath.map((r) => r.content).filter((c) => normText(c).length > 0);

  if (fresh) {
    const truth = fresh.content;
    // An empty (or whitespace-only) file cannot be checked by containment: "" is in everything.
    if (normText(truth).length === 0) return null;
    const m = bytes(normText(truth));
    const delivered = answers.length > 0 ? answers : walkReads;
    if (delivered.length === 0) return null; // the walk delivered nothing gradeable (an empty read)
    const cf = compare(delivered, truth);
    if (cf.kind === "carries") {
      return {
        reached: true,
        reason: `deterministic:verified-verbatim-read — re-read ${path} through the fileContent producer (${m} bytes) and the walk's delivered ${answers.length > 0 ? "answer" : "read"} carries it exactly`,
        completion_shapes: ["fileContent"],
        deterministic: true,
      };
    }
    // A CHANGED FILE ABSTAINS, IT DOES NOT FAIL. The walk read W, the fresh read says F != W, and
    // what the walk delivered is W: the walk reported faithfully what the file said when it read it.
    // Between the two reads the file changed (or the producer is nondeterministic) — either way this
    // oracle cannot say the walk was wrong, so the judge decides.
    const changed = walkReads.filter((w) => normText(w) !== normText(truth));
    if (changed.length > 0 && (answers.length === 0 || changed.some((w) => compare(answers, w).kind === "carries"))) {
      noteAbstain?.(`file changed since read — the walk's read of ${path} (${bytes(normText(changed[0]!))} bytes) differs from a fresh re-read (${m} bytes) and the delivered output matches the walk's read`);
      return null;
    }
    // TRUNCATION, measured against the reference the answer was cut from. First the walk's own read
    // (an answer that stops short of what the walk had is truncated whatever the file says now), then
    // the fresh read.
    let tw: { n: number; m: number } | null = null;
    for (const w of walkReads) {
      const c = compare(answers, w);
      if (c.kind === "prefix" && (!tw || c.n > tw.n)) tw = { n: c.n, m: bytes(normText(w)) };
    }
    if (tw) {
      return { reached: false, reason: `deterministic:verbatim-read-truncated — truncated: ${tw.n} of ${tw.m} bytes of the walk's read of ${path} delivered`, completion_shapes: [] };
    }
    if (cf.kind === "prefix") {
      return { reached: false, reason: `deterministic:verbatim-read-truncated — truncated: ${cf.n} of ${m} bytes of ${path} delivered`, completion_shapes: [] };
    }
    return {
      reached: false,
      reason: `deterministic:verbatim-read-mismatch — the delivered answer matches neither the walk's read of ${path} nor a fresh re-read through the fileContent producer (${m} bytes)`,
      completion_shapes: [],
    };
  }

  // No fresh read. The walk's own producer read is the only ground truth left, and comparing it to
  // itself proves nothing — so grade only a SEPARATE answer text against it, and only when that
  // text clearly carries it or clearly cuts it short. Anything else is the judge's call.
  const truth = forPath[0]!.content;
  if (normText(truth).length === 0 || answers.length === 0) return null;
  const c = compare(answers, truth);
  const m = bytes(normText(truth));
  if (c.kind === "carries") {
    return {
      reached: true,
      reason: `deterministic:verified-verbatim-read — the answer carries the walk's fileContent read of ${path} (${m} bytes) exactly (fresh re-read unavailable)`,
      completion_shapes: ["fileContent"],
      deterministic: true,
    };
  }
  if (c.kind === "prefix") {
    return {
      reached: false,
      reason: `deterministic:verbatim-read-truncated — truncated: ${c.n} of ${m} bytes of ${path} delivered`,
      completion_shapes: [],
    };
  }
  return null;
}


// ── SHADOW JUDGE (measurement, never control) ───────────────────────────────────────────────────
// A new oracle that overrides the judge has to EARN that precedence with evidence. For the first N
// in-family deterministic verdicts the LLM judge is still consulted — in shadow: its verdict is
// logged and, on disagreement, written into the label corpus, but it never reaches the returned
// verdict. The run is fire-and-forget (the caller does not await it) and every failure inside it is
// logged and swallowed, so it can neither block nor alter grading.

export const VERBATIM_SHADOW_DEFAULT_N = 20;
// The shadow window CLOSES ON ITS OWN: seven days after this oracle lands (2026-10-01). A shadow
// that runs forever is a standing LLM cost with no question left to answer; to keep measuring,
// extend it through the policy (verbatimReadShadowPolicy.shadow_until), not by editing this date.
export const VERBATIM_SHADOW_DEFAULT_UNTIL = "2026-10-08T00:00:00Z";

export interface ShadowBudget { n: number; untilMs: number }

/** Read the shadow budget from a verbatimReadShadowPolicy document (null = no document: defaults). */
export function shadowBudgetFrom(pol: Record<string, unknown> | null | undefined): ShadowBudget {
  const n = Number(pol?.["shadow_n"]);
  const until = Date.parse(String(pol?.["shadow_until"] ?? ""));
  return {
    n: Number.isFinite(n) && n >= 0 ? Math.floor(n) : VERBATIM_SHADOW_DEFAULT_N,
    untilMs: Number.isFinite(until) ? until : Date.parse(VERBATIM_SHADOW_DEFAULT_UNTIL),
  };
}

export interface ShadowJudgeVerdict { reached: boolean; reason?: string }

export interface ShadowDeps {
  /** The LLM judge, as it would have graded this goal without the oracle. */
  judge: () => Promise<ShadowJudgeVerdict | null>;
  /** The shadow budget: per-process count N and a durable end time (policy-backed in the vessel). */
  budget: () => Promise<ShadowBudget>;
  /** Durable record of a disagreement (the vessel writes a goal_verification_label). */
  recordDisagreement: (oracle: GoalReachVerdictLike, judge: ShadowJudgeVerdict) => void;
  log: (line: string) => void;
  now?: () => number;
}

export function createVerbatimShadow() {
  let slots = 0;
  // One shadow per dispatch (or execution): the interim and end-of-walk gates both see the same
  // verdict, and N is meant to count distinct goals, not gate passes.
  const seen = new Set<string>();
  return {
    /** Slots claimed so far (a slot is claimed before the budget is read, so concurrent runs cannot overshoot). */
    get claimed(): number { return slots; },
    async run(oracle: GoalReachVerdictLike, deps: ShadowDeps, key: string): Promise<void> {
      if (seen.has(key)) return;
      if (seen.size >= 4096) seen.clear();
      seen.add(key);
      const o = oracle.reached ? "reached" : "fail";
      try {
        const b = await deps.budget();
        if ((deps.now ?? Date.now)() >= b.untilMs) return;
        const slot = slots++;
        if (slot >= b.n) return;
        let j: ShadowJudgeVerdict | null;
        try { j = await deps.judge(); } catch (e) {
          deps.log(`[verbatim-read-oracle] shadow oracle=${o} judge=error agree=unknown reason=shadow judge failed (ignored): ${(e as Error)?.message ?? e}`);
          return;
        }
        if (!j) {
          deps.log(`[verbatim-read-oracle] shadow oracle=${o} judge=unavailable agree=unknown reason=the judge returned no verdict (ignored)`);
          return;
        }
        const agree = j.reached === oracle.reached;
        deps.log(`[verbatim-read-oracle] shadow oracle=${o} judge=${j.reached ? "reached" : "hollow"} agree=${agree} reason=${String(j.reason ?? "").slice(0, 200)}`);
        if (!agree) deps.recordDisagreement(oracle, j);
      } catch (e) {
        try { deps.log(`[verbatim-read-oracle] shadow comparison failed (ignored): ${(e as Error)?.message ?? e}`); } catch { /* nothing left to tell */ }
      }
    },
  };
}
