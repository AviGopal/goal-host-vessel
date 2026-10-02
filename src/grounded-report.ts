/**
 * G1 — THE GROUNDED CURRENT-EVENTS REPORT ORACLE (output-shapes track 4 §4.1, slice V "known risk").
 *
 * MEASURED: the LLM judge rejected the two grounded reports of the a30a893c family in the 09-30 → 10-01
 * window on format ("missing a coherent report format", "overly generic"), and rejected fb068805's
 * 4,470-char dated, sourced report after V2 and V3 had landed. Prose in the judge prompt did not hold
 * for this class (8a85cfa, 2c26fcb). So the in-family verdict is computed here, from the run's own
 * evidence, never from the judge's reading of it.
 *
 * Authority: the host clock read at use time, and the run's own consumed search results — reached
 * through the walk's provenance EDGES (V4 `consumedIds`), not through text the deliverable claims.
 * "Grounded" means the run's evidence bounds the content; it does not mean the report is true.
 *
 * It only ever says REACHED, or abstains (null) and the judge grades as before. Every unmet condition
 * is an abstain with a named reason:
 *   family      — a time-relative goal ("today", "yesterday", …) asking for a report/headlines/news;
 *   deliverable — the latest answer-shape impulse of a SURFACED shape (the walk's terminals/targets)
 *                 that CONSUMED ≥1 search-result impulse (edge, not text);
 *   siblings    — no other answer-shape impulse carries a placeholder, and no later answer is ungrounded
 *                 (what the person is shown must be what is graded);
 *   placeholders — "[Headline 1]", "[Insert …]", "{{current_date}}" in the deliverable;
 *   subject     — every subject word of the goal (not instruction vocabulary) is shared by the search
 *                 query or a result title;
 *   date        — it asserts ≥1 report date, and every asserted date is the clock date (±1 day, after
 *                 the goal's offset) — reach-date.ts's own parse and window;
 *   urls        — every URL it cites is in the consumed results (a planted URL abstains);
 *   items       — ≥N items, each naming a consumed result (url or headline title) that is not dated
 *                 outside the window, followed by ≥K words BEYOND that title and its snippet, sharing
 *                 ≥M content words with the result (commentary on it, not filler);
 *   hosts       — the grounded items span ≥H distinct result hosts.
 * Thresholds and the observe/decide MODE are the shaped groundedReportPolicy (law 1), below.
 */
import { ANSWER_SHAPES, assertedDates, isStaleDate, timeRelativeOffset } from "./reach-date";
import { deliverableText } from "./judge-view";

/** Shapes whose content is a SEARCH RESULT SET. Only these ground an item: a fetched page is the
 *  world's text, not a result list the writer was shown. */
export const SEARCH_RESULT_SHAPES: ReadonlySet<string> = new Set(["web_search", "webSearchResult"]);

export interface PoolEvidence { id: string; shape: string; content: unknown; consumedIds?: readonly string[] }

/**
 * groundedReportPolicy — `WORKSPACE_ROOT/policies/groundedReportPolicy.json` (law 1).
 *
 * MODE. With no document, or without `enabled: true`, G1 only OBSERVES: the LLM judge decides reach,
 * and G1's verdict is logged and written as a shadow label beside the judge's (measured agreement).
 * `enabled: true` makes G1 decide reach in-family; the same switch is what lets a G1 reach earn α
 * credit and a mint, because a G1 verdict is returned (deterministic) only then. PROMOTION RULE:
 * set `enabled: true` only after the observe labels show G1 agreeing with the judge on ≥ 90% of
 * ≥ 10 in-family verdicts, with every disagreement read by hand. (This deviates from output-shapes
 * §4.1, which made the oracle authoritative in-family on landing; qa11's probes showed the predicate
 * must earn that first.)
 */
export interface GroundedReportPolicy {
  /** true = G1 decides reach in-family; anything else = observe only. */
  enabled: boolean;
  /** Items each naming a consumed result. */
  min_items: number;
  /** Words in an item beyond the matched title, its snippet and any URL: the commentary proxy. */
  min_item_words: number;
  /** Distinct content words the commentary shares with its matched result (title + snippet): on topic. */
  min_item_overlap: number;
  /** Distinct hosts the grounded items must span. */
  min_hosts: number;
  /** …raised to this when the goal asks for "multiple sources" / "several sources". */
  multi_source_min_hosts: number;
  /** A result title shorter than this never grounds an item (a short title matches by accident). */
  min_title_chars: number;
  /** A result that carries a date (field, URL path, ISO date in the snippet) older than this many
   *  days before the goal's day cannot ground an item. */
  max_result_age_days: number;
  /** Extra goal words treated as instruction vocabulary, not as a subject, by the subject check. */
  generic_terms: string[];
}

export const GROUNDED_REPORT_DEFAULTS: GroundedReportPolicy = {
  enabled: false,
  min_items: 2,
  min_item_words: 30,
  min_item_overlap: 3,
  min_hosts: 1,
  multi_source_min_hosts: 2,
  min_title_chars: 25,
  max_result_age_days: 2,
  generic_terms: [],
};

/** Read groundedReportPolicy (null = no document ⇒ defaults, i.e. observe). Unusable fields keep their
 *  default; a policy is never half-parsed. */
export function groundedReportPolicyFrom(pol: Record<string, unknown> | null | undefined): GroundedReportPolicy {
  const out: GroundedReportPolicy = { ...GROUNDED_REPORT_DEFAULTS, generic_terms: [] };
  if (!pol) return out;
  out.enabled = pol["enabled"] === true;
  for (const k of ["min_items", "min_item_words", "min_item_overlap", "min_hosts", "multi_source_min_hosts", "min_title_chars", "max_result_age_days"] as const) {
    const n = Number(pol[k]);
    if (pol[k] !== undefined && pol[k] !== null && Number.isFinite(n) && n >= 1) out[k] = Math.floor(n);
  }
  if (Array.isArray(pol["generic_terms"])) out.generic_terms = (pol["generic_terms"] as unknown[]).filter((t): t is string => typeof t === "string").map((t) => normText(t)).filter(Boolean);
  return out;
}

export interface GroundedReportVerdict {
  reached: true;
  reason: string;
  completion_shapes: string[];
  deterministic: true;
}

const REPORT_RE = /\b(report|summary|summari[sz]e|headlines?|news|briefing|digest|round-?up)\b/i;
const MULTI_SOURCE_RE = /\b(multiple|several|many|various|different)\s+(?:news\s+)?(sources|outlets|sites|publications)\b/i;

/** Template residue: an unfilled slot is never a report, whatever surrounds it. */
const PLACEHOLDER_RE = /\{\{[^}]*\}\}|\[(?:insert|your|headline\s*\d*|source(?:\s+name)?|current\s+date|date|today'?s\s+date|brief\s+summary|summary|commentary|link|url|title|name|month|year|recent\s+month)[^\]]*\]/i;

type Result = { title: string; url: string; host: string; snippet: string; date: number | null };

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

function normUrl(u: string): string {
  return u.replace(/[)\].,;:!?'"*>]+$/, "").replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

/** Lower-case alphanumerics separated by single spaces: quotes, dashes and markup never decide a match. */
export function normText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const MON3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The date a search result carries, if any: a date field, a dated URL path (/2026/10/2/,
 *  /2019/jul/23/), else an ISO date in its snippet. null = undated (never penalised). */
export function resultDateOf(o: Record<string, unknown>, url: string, snippet: string): number | null {
  for (const k of ["date", "published", "publishedDate", "published_at", "datePublished", "page_date"]) {
    const v = o[k];
    if (typeof v === "string" && /\d{4}/.test(v)) { const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  }
  const m = url.match(/\/((?:19|20)\d\d)\/(\d{1,2}|[a-z]{3})\/(\d{1,2})(?:\/|$)/i);
  if (m) {
    const mon = /^\d+$/.test(m[2]!) ? +m[2]! - 1 : MON3.indexOf(m[2]!.toLowerCase());
    if (mon >= 0 && mon < 12) return Date.UTC(+m[1]!, mon, +m[3]!);
  }
  const iso = snippet.match(/\b((?:19|20)\d\d)-(\d\d)-(\d\d)\b/);
  if (iso) return Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!);
  return null;
}

/** Goal words that are instructions or the family's own vocabulary, never a SUBJECT. */
const GENERIC_GOAL_TERMS: ReadonlySet<string> = new Set((
  "what whats is are was happening happen happened going on today todays tonight yesterday tomorrow this that these morning afternoon evening right now day daily " +
  "should search searching web internet online for from multiple several many various different sources source outlets sites publications " +
  "get find look up fetch use using the a an and or of to in on at by as with about any all each every one some its it be also then " +
  "current date dates recent month months year years latest newest new top main major key biggest important notable " +
  "produce write create make give me us our my you your please provide list including include tell show " +
  "headlines headline news stories story report reports summary summarize summarise summarising summarizing briefing digest roundup round " +
  "commentary comment comments analysis overview update updates brief short quick world global international events event " +
  "how why who when where which there here their them they"
).split(" "));

const STOP_OVERLAP: ReadonlySet<string> = new Set((
  "that this with have been from were will they their which what about after into over more said says also than then when where while would could should " +
  "there these those today report reports headline headlines commentary news being other such some very just only most much many"
).split(" "));

const contentWords = (normalized: string): Set<string> =>
  new Set(normalized.split(" ").filter((w) => w.length >= 4 && !STOP_OVERLAP.has(w) && !/^\d+$/.test(w)));

/** Every `{title, url}` result object in a search payload (string JSON or object, nested). */
export function searchResultsOf(c: unknown): Result[] {
  const out: Result[] = [];
  const walk = (x: unknown, depth: number): void => {
    if (depth > 6 || x === null || x === undefined) return;
    if (typeof x === "string") {
      if (depth === 0) { try { walk(JSON.parse(x), depth + 1); } catch { /* plain text: no results */ } }
      return;
    }
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    if (typeof x === "object") {
      const o = x as Record<string, unknown>;
      const url = typeof o.url === "string" ? o.url : typeof o.link === "string" ? o.link : null;
      if (url && /^https?:\/\//.test(url)) {
        const snippet = typeof o.snippet === "string" ? o.snippet : typeof o.description === "string" ? o.description : typeof o.content === "string" ? o.content : "";
        out.push({ title: typeof o.title === "string" ? o.title : "", url, host: hostOf(url), snippet, date: resultDateOf(o, url, snippet) });
        return;
      }
      for (const v of Object.values(o)) walk(v, depth + 1);
    }
  };
  walk(c, 0);
  return out;
}

/** The headline part of a result title: the text before the site/section suffix
 *  ("… | US-Israel war on Iran News | Al Jazeera", "… – Europe live"). */
export function headlineOf(title: string): string {
  return title.split(/\s+[|–—]\s+|\s+-\s+/)[0]!.trim();
}

/** Item blocks: numbered entries ("1.", "**1.", "### 1)") or, failing those, markdown headings. Text
 *  before the first item is preamble and is not an item. */
export function itemBlocks(text: string): string[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const numbered = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*\d{1,2}[.)]\s+\S/;
  const heading = /^\s*#{2,6}\s+\S/;
  const starts = (re: RegExp) => lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
  let idx = starts(numbered);
  if (idx.length === 0) idx = starts(heading);
  return idx.map((s, k) => lines.slice(s, k + 1 < idx.length ? idx[k + 1] : lines.length).join("\n"));
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

export interface GroundedReportInput {
  goal: string;
  pool: readonly PoolEvidence[];
  /** The shapes the walk SURFACES as its deliverable (derivation terminals + targets). The judged
   *  answer must be one of them: G1 grades what the person is shown, not an intermediate. */
  surfaced?: readonly string[];
  policy?: GroundedReportPolicy;
  now?: Date;
  onAbstain?: (why: string) => void;
}

/**
 * `reached:true` for a dated, edge-grounded, itemised report in the family; `null` (abstain) otherwise.
 * Never returns a not-reached verdict: a stale date is the asserted-date oracle's, and everything else
 * this oracle cannot establish is left to the judge.
 */
export function verifyGroundedReport(input: GroundedReportInput): GroundedReportVerdict | null {
  const { goal, pool } = input;
  const policy = input.policy ?? GROUNDED_REPORT_DEFAULTS;
  const now = input.now ?? new Date();
  const abstain = (why: string): null => { input.onAbstain?.(why); return null; };

  // Out of family: silent (no log line per non-news goal).
  const offset = timeRelativeOffset(goal);
  if (offset === null || !REPORT_RE.test(goal)) return null;

  // ── the deliverable, by EDGE: a SURFACED answer that consumed a search-result impulse ─────────
  const byId = new Map(pool.map((p) => [p.id, p] as const));
  const surfaced = new Set(input.surfaced ?? []);
  if (surfaced.size === 0) return abstain("no surfaced deliverable shapes were named (only the walk's end-of-walk gate passes them)");
  const edged = (p: PoolEvidence) => (p.consumedIds ?? []).some((id) => SEARCH_RESULT_SHAPES.has(byId.get(id)?.shape ?? ""));
  const candidates = pool.filter((p) => ANSWER_SHAPES.has(p.shape) && surfaced.has(p.shape) && edged(p));
  if (candidates.length === 0) return abstain(`no surfaced answer shape [${[...surfaced].join(",")}] consumed a search result (no edge to evidence)`);
  const deliverable = candidates[candidates.length - 1]!; // the walk's latest surfaced, edged answer
  // ── what ELSE the walk answered: a placeholder sibling, or a later answer the edge does not ground,
  //    is what the person may be shown instead — G1 does not grade around it ─────────────────────
  const at = pool.indexOf(deliverable);
  for (const [i, p] of pool.entries()) {
    if (p === deliverable || !ANSWER_SHAPES.has(p.shape)) continue;
    const t = deliverableText(p.content);
    const m = t.match(PLACEHOLDER_RE);
    if (m) return abstain(`another answer-shape impulse (${p.shape}) carries a template placeholder "${m[0].slice(0, 40)}"`);
    if (i > at && !edged(p) && t.trim()) return abstain(`a later answer (${p.shape}) is not grounded in a consumed search`);
  }
  const consumed = (deliverable.consumedIds ?? []).map((id) => byId.get(id)).filter((p): p is PoolEvidence => !!p && SEARCH_RESULT_SHAPES.has(p.shape));
  const results = consumed.flatMap((p) => searchResultsOf(p.content));
  if (results.length === 0) return abstain(`the consumed ${consumed.map((p) => p.shape).join(",")} carried no {title,url} results`);
  const text = deliverableText(deliverable.content);
  if (!text.trim()) return abstain("the deliverable is empty");

  // ── subject: a goal that names a subject (technology, sports, a vessel, a test) is answered only
  //    by a search that shares it — the query or the result titles. Conservative: any unshared
  //    subject word abstains. ────────────────────────────────────────────────────────────────────
  const generic = new Set([...GENERIC_GOAL_TERMS, ...policy.generic_terms]);
  const subject = [...new Set(normText(goal).split(" "))].filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !generic.has(w));
  if (subject.length > 0) {
    const queries = consumed.map((p) => { const c = p.content; try { const o = (typeof c === "string" ? JSON.parse(c) : c) as { query?: unknown }; return typeof o?.query === "string" ? o.query : ""; } catch { return ""; } });
    const hay = new Set(normText([...queries, ...results.map((r) => r.title)].join(" ")).split(" "));
    const shares = (w: string) => hay.has(w) || (w.length >= 5 && [...hay].some((h) => h.startsWith(w.slice(0, 5))));
    const unshared = subject.filter((w) => !shares(w));
    if (unshared.length > 0) return abstain(`the goal names [${unshared.join(", ")}], which neither the search query nor any result title shares`);
  }

  // ── template residue ─────────────────────────────────────────────────────────────────────────
  const ph = text.match(PLACEHOLDER_RE);
  if (ph) return abstain(`the deliverable carries a template placeholder "${ph[0].slice(0, 40)}"`);

  // ── the date: asserted, and on the clock (reach-date.ts parse and ±1-day window) ─────────────
  const target = new Date(now.getTime() + offset * 86_400_000);
  const dates = assertedDates(`- ${deliverable.shape}: ${text}`);
  if (dates.length === 0) return abstain("the deliverable asserts no report date");
  const stale = dates.find((d) => isStaleDate(d, target));
  if (stale) return abstain(`the deliverable asserts "${stale.text.trim()}", off the clock date ${target.toISOString().slice(0, 10)}`);

  // ── every cited URL is a consumed result ─────────────────────────────────────────────────────
  const resultUrls = new Map(results.map((r) => [normUrl(r.url), r] as const));
  const cited = [...new Set((text.match(URL_RE) ?? []).map(normUrl))];
  const planted = cited.filter((u) => !resultUrls.has(u));
  if (planted.length > 0) return abstain(`the deliverable cites ${planted.length} URL(s) absent from the consumed results (e.g. ${planted[0]!.slice(0, 120)})`);

  // ── items: each names a FRESH consumed result and says something ON IT of its own ─────────────
  const oldest = target.getTime() - policy.max_result_age_days * 86_400_000 - 86_400_000;
  const newest = target.getTime() + 2 * 86_400_000;
  const fresh = (r: Result) => r.date === null || (r.date >= oldest && r.date <= newest);
  const titled = results
    .map((r) => ({ r, keys: [...new Set([normText(r.title), normText(headlineOf(r.title))])].filter((k) => k.length >= policy.min_title_chars) }))
    .filter((t) => t.keys.length > 0);
  const blocks = itemBlocks(text);
  if (blocks.length === 0) return abstain("no item structure (numbered entries or headings) in the deliverable");
  const grounded: Array<{ hosts: Set<string>; words: number; via: string }> = [];
  const why: string[] = [];
  for (const [n, b] of blocks.entries()) {
    const nb = normText(b);
    const hits: Result[] = [];
    for (const u of (b.match(URL_RE) ?? []).map(normUrl)) { const r = resultUrls.get(u); if (r) hits.push(r); }
    for (const t of titled) if (t.keys.some((key) => nb.includes(key))) hits.push(t.r);
    if (hits.length === 0) { why.push(`item ${n + 1}: names no consumed result`); continue; }
    const live = hits.filter(fresh);
    if (live.length === 0) { why.push(`item ${n + 1}: its result is dated outside the window`); continue; }
    // Commentary = the item minus every matched title, its snippet (whole and per passage) and URLs (§4.1).
    let rest = ` ${nb.replace(/\bhttps? [^ ]+/g, " ")} `;
    const cut = (k: string) => { if (k.length > 0) rest = rest.split(` ${k} `).join(" "); };
    for (const r of live) {
      cut(normText(r.title)); cut(normText(headlineOf(r.title)));
      cut(normText(r.snippet));
      for (const seg of r.snippet.split(/\n+|\.\.\.|…|(?<=[.!?])\s+/)) { const ns = normText(seg); if (ns.split(" ").length >= 4) cut(ns); }
    }
    const restWords = rest.split(" ").filter((w) => w.length > 0);
    if (restWords.length < policy.min_item_words) { why.push(`item ${n + 1}: ${restWords.length} words beyond title and snippet`); continue; }
    const source = new Set(live.flatMap((r) => [...contentWords(normText(`${r.title} ${r.snippet}`))]));
    const overlap = [...contentWords(restWords.join(" "))].filter((w) => source.has(w));
    if (overlap.length < policy.min_item_overlap) { why.push(`item ${n + 1}: commentary shares ${overlap.length} content word(s) with its result`); continue; }
    grounded.push({ hosts: new Set(live.map((h) => h.host).filter(Boolean)), words: restWords.length, via: live[0]!.url });
  }
  const minItems = policy.min_items;
  if (grounded.length < minItems) return abstain(`${grounded.length} of ${blocks.length} item(s) name a fresh consumed result with ≥${policy.min_item_words} on-topic words of their own; ${minItems} required (${why.join("; ").slice(0, 300)})`);
  const hosts = new Set(grounded.flatMap((g) => [...g.hosts]));
  const minHosts = MULTI_SOURCE_RE.test(goal) ? Math.max(policy.min_hosts, policy.multi_source_min_hosts) : policy.min_hosts;
  if (hosts.size < minHosts) return abstain(`grounded items span ${hosts.size} host(s); ${minHosts} required`);

  const clock = now.toISOString().slice(0, 10);
  return {
    reached: true,
    deterministic: true,
    completion_shapes: [deliverable.shape],
    reason: `deterministic:grounded-report — ${deliverable.shape} (${text.length} chars) consumed ${consumed.length} search impulse(s) [${consumed.map((p) => p.id).join(",")}]; asserts ${dates.map((d) => `"${d.text.trim()}"`).join(", ")} against the host clock ${clock}${offset !== 0 ? ` (goal offset ${offset} day)` : ""}; ${grounded.length} of ${blocks.length} items each name a fresh consumed result with ≥${policy.min_item_words} on-topic words of their own, spanning ${hosts.size} host(s) [${[...hosts].join(", ")}]`,
  };
}

/** Untruncated pool evidence for the oracle: the walk's pool impulses with their provenance edges. */
export function poolEvidenceOf(imps: ReadonlyArray<{ id: string; content?: unknown; metadata?: unknown }>): PoolEvidence[] {
  return imps.map((im) => {
    const m = (im.metadata ?? {}) as { shape?: string; consumedIds?: string[] };
    return { id: im.id, shape: String(m.shape ?? ""), content: im.content, ...(Array.isArray(m.consumedIds) ? { consumedIds: [...m.consumedIds] } : {}) };
  });
}

