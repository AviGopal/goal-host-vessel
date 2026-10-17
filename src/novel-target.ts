/**
 * J2b: A GOAL WHOSE OUTPUT NO EXISTING SHAPE PRODUCES IS NAMED AS NOVEL (user statement 2026-10-17 "What of new shapes?",
 * case B; design J1-J4.md §J2 with qa's ruling that trigger (i) returns here as novel_target).
 *
 * The target chooser (the LLM, shown the candidates) used to be told it MUST pick from the list, so a goal that needs an
 * output nothing produces was forced onto the nearest wrong shape, or emptied and then filled by the lexical fallback.
 * The chooser may now answer NOVEL: no target, plus a DESCRIBED RESIDUAL, i.e. what output the goal needs, the closest
 * existing candidate, and why that candidate's production would not satisfy it (B4: the best existing candidate and why
 * it fails is a FIELD, not a log line). The decision carries the answer as given; nothing lexical overrides it.
 *
 * What it changes downstream: nothing is cut off. The walk's existing fallbacks (the shell safety net, the overrides,
 * the floor) still run, so ReAct parity holds. A dispatch that then does not reach ends needs_information with reason
 * novel_target and the residual, which the composite-authoring path consumes (B2; a later piece, not this one).
 *
 * WHAT THE TESTS PROVE: with a stubbed chooser, that the mechanism carries the chooser's answer and that no lexical
 * route overrides it (the crossed pairs). Whether the chooser recognises MEANING is proved only by the live check
 * against real embeddings and a real model, not by these tests.
 */
export interface NovelTarget {
  /** what output the goal needs that no candidate produces, in the chooser's words (bounded) */
  residual: string;
  /** the nearest existing candidate and why its production would not satisfy the goal; null if none was named validly */
  closest: { shape: string; why_not: string } | null;
}

const MAX_TEXT = 400;
const text = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "");

/** The NOVEL answer in a chooser's parsed JSON, if it gave one. `candidates` bounds what `closest` may name. */
export function parseNovel(parsed: Record<string, unknown> | null | undefined, candidates: ReadonlySet<string>): NovelTarget | null {
  const n = parsed?.["novel"];
  if (!n || typeof n !== "object" || Array.isArray(n)) return null;
  const o = n as Record<string, unknown>;
  const residual = text(o["residual"]);
  if (!residual) return null;
  const shape = text(o["closest"]);
  const why = text(o["why_not"]);
  return { residual, closest: shape && candidates.has(shape) ? { shape, why_not: why || "(no reason given)" } : null };
}

/** The option every chooser prompt offers, so it never has to force a wrong shape. */
export const NOVEL_OPTION =
  `\n\nIf NO listed shape's production would satisfy the goal, do not force one. Return {"target_shapes": [], "novel": {"residual": "<one sentence: the output this goal needs that no listed shape produces>", "closest": "<the listed shape that comes nearest>", "why_not": "<why producing that shape would not satisfy the goal>"}}.`;
