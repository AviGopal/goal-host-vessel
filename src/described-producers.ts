/**
 * TARGETS ARE VALID DESCRIBED PRODUCERS (I-T (i) + (iii); check-first test/goal-target-needs.test.ts, 6f33598).
 *
 * Measured: a quantitative question about a store served through an advertised READ shape was aimed at the universal
 * executor (shellResult) with no command to run, because target inference saw shape NAMES only; discovery serves
 * descriptions (/registry/shape-descriptions) but nothing read them at choice time. And a compound request ("find X,
 * and then do Y with it") kept one need and dropped the other.
 *
 * The deterministic layer here is a VALIDITY constraint, not a preference:
 *   VALIDITY  a target is valid only if it is advertised AND every required input is bindable from the goal or the
 *             pool. An invalid target is never chosen, whoever proposes it (a shortcut, the LLM, the fallback).
 *   CHOICE    among valid candidates only: the chooser is the LLM, shown the valid candidates' descriptions. A lexical
 *             match over descriptions is ONLY the fallback tier when no chooser answers, and it never overrides a valid
 *             chooser's answer.
 *   NEEDS     a need the chooser left uncovered is recalled BY MEANING on its residual (goal-target-inference
 *             residualChoice, piece 5); the lexical restore that lived here is retired.
 * No wording list: words are weighted by how many descriptions in the catalog carry them (an inverse frequency), so a
 * function word common to many descriptions carries little weight and no stopword list exists. Opaque shape names and
 * reworded descriptions (the test's synthetic registries) defeat any name or keyword route.
 *
 * NAMED DEBT: `requires` (which inputs a producer needs, and from where) comes from the catalog the caller supplies.
 * Production's catalog today is descriptions only (discovery serves no per-input source), so production validity is
 * "advertised" alone until resolver schemas state where each required input comes from.
 */

export type RequiredInput =
  | { name: string; from: "goal"; literal: "code" | "token" }
  | { name: string; from: "pool"; shape: string };
export type CatalogEntry = { description: string; requires?: RequiredInput[] };
export type ShapeCatalog = Record<string, CatalogEntry>;
export type Candidate = { shape: string; valid: boolean; reason: string };
export type ChooserTier = "llm" | "posterior" | "fallback" | "deterministic";

/** One word form for matching: lowercase alphanumerics with a plain plural or -ing/-ed ending removed. */
export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.endsWith("ies") && s.length > 4) return s.slice(0, -3) + "y";
  if (s.endsWith("ing") && s.length > 5) return s.slice(0, -3);
  if (s.endsWith("ed") && s.length > 4) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && s.length > 3) s = s.slice(0, -1);
  return s;
}
export function wordsOf(text: string): Set<string> {
  return new Set(text.replace(/['’]s\b/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem));
}

const CODE_SPAN = /`[^`]+`|"[^"]+"|'[^'\s][^']*'/;
const TOKEN_LITERAL = /\b[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/;

/** Whether `shape` is a valid target for `goal`: advertised, and every required input bindable. */
export function validity(shape: string, known: ReadonlySet<string>, catalog: ShapeCatalog, goal: string, poolShapes: readonly string[]): Candidate {
  if (!known.has(shape)) return { shape, valid: false, reason: "not advertised" };
  for (const r of catalog[shape]?.requires ?? []) {
    if (r.from === "pool") {
      if (!poolShapes.includes(r.shape)) return { shape, valid: false, reason: `required input ${r.name} unbound: no ${r.shape} in the pool` };
    } else if (r.literal === "code") {
      if (!CODE_SPAN.test(goal)) return { shape, valid: false, reason: `required input ${r.name} unbound: the goal carries no quoted or backticked span to bind it` };
    } else if (!CODE_SPAN.test(goal) && !TOKEN_LITERAL.test(goal)) {
      return { shape, valid: false, reason: `required input ${r.name} unbound: the goal carries no literal value to bind it` };
    }
  }
  return { shape, valid: true, reason: catalog[shape] ? "advertised; required inputs bindable" : "advertised; undescribed" };
}

/** The described-candidates block a chooser is shown: every VALID candidate with its description. */
export function describedCandidatesBlock(valid: readonly string[], catalog: ShapeCatalog): string {
  const lines = valid.filter((s) => catalog[s]).map((s) => `- ${s}: ${catalog[s]!.description}`);
  return lines.length === 0 ? "" : `\n\nVALID CANDIDATES and what each produces (choose ONLY among these; any other shape is not producible for this goal):\n${lines.join("\n")}`;
}

type Index = { words: Map<string, Set<string>>; df: Map<string, number>; n: number };
function indexOf(catalog: ShapeCatalog): Index {
  const words = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const [s, e] of Object.entries(catalog)) {
    const w = wordsOf(e.description);
    words.set(s, w);
    for (const t of w) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { words, df, n: Math.max(1, words.size) };
}
const covered = (ix: Index, shape: string, goalWords: Set<string>): Set<string> => new Set([...goalWords].filter((t) => ix.words.get(shape)?.has(t)));
const weight = (ix: Index, t: string) => Math.log(ix.n / (ix.df.get(t) ?? ix.n));

/** The FALLBACK tier only: the valid described candidate whose description best covers the goal's words. */
export function lexicalChoice(goal: string, valid: readonly string[], catalog: ShapeCatalog): string | null {
  const ix = indexOf(catalog);
  const g = wordsOf(goal);
  let best: { s: string; score: number } | null = null;
  for (const s of valid) {
    if (!catalog[s]) continue;
    const score = [...covered(ix, s, g)].reduce((a, t) => a + weight(ix, t), 0);
    if (score > 0 && (!best || score > best.score)) best = { s, score };
  }
  return best?.s ?? null;
}
