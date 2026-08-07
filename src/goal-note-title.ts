/**
 * The note title a goal explicitly names ("... a durable note titled X"), or null.
 *
 * Shared by the composed-write title binding and the terminal-output bridge: BOTH must
 * address the same artifact, or the bridge "repairs" the goal's note by writing a second
 * one beside it under a title slugified from the goal text — a duplicate that reads as a
 * success while the named note keeps whatever placeholder was left in it. Observed
 * exactly that way (dispatch 86f317f1) before the two sites shared this parse.
 *
 * Lives in its own module because index.ts boots a server on import, so anything defined
 * there is untestable — the same reason parseFileExtension was extracted after it
 * produced a false green AND a false red from one unexercised branch.
 */

/**
 * Order the durable-write sinks a walk may deliver into, by how the GOAL addresses its
 * artifact rather than by Set iteration order.
 *
 * A re-framed walk can carry both a title-addressed store shape (`memoryNote_write`) and a
 * path-addressed vault shape (`obsidian:write_note`) in its target set, and whichever came
 * first won. Observed live: a goal naming "a durable note titled boredom-vessel-purpose"
 * had its content written to a vault note while the note it named kept its placeholder —
 * and the bridge logged that as a success.
 *
 * `obsidian:write_note` is always appended as the tail fallback, deduplicated.
 */
export function orderWriteSinks(targetShapes: Iterable<string>, goalNamesATitle: boolean): string[] {
  const isTitleAddressed = (s: string): boolean => !/:write_note$/.test(s);
  const declared = [...targetShapes]
    .map(String)
    .filter((s) => /(?:_write|:write_note)$/.test(s))
    // Stable unless the goal named a title, in which case title-addressed sinks lead.
    .sort((a, b) => (goalNamesATitle ? (isTitleAddressed(b) ? 1 : 0) - (isTitleAddressed(a) ? 1 : 0) : 0));
  // A TITLED GOAL GETS THE NOTE STORE AS A CANDIDATE EVEN IF THE WALK NEVER TARGETED IT.
  // Ordering can only reorder what target already holds, and target comes from shape
  // inference — which does not always infer memoryNote_write. Observed live: a goal ending
  // "...record it as a durable note titled harness-b0-g4" inferred only vault shapes, so the
  // ordering had nothing to promote and the content went to a vault note while the named
  // note was never written at all. Discovery still decides whether the shape is advertised
  // here; this only makes it eligible, exactly as obsidian:write_note already is.
  const titleSink = goalNamesATitle ? ['memoryNote_write'] : [];
  return [...titleSink, ...declared, 'obsidian:write_note'].filter((s, i, a) => a.indexOf(s) === i);
}

/** The title a goal names for a durable note, or null when it names none. */
export function parseGoalNoteTitle(goal: string): string | null {
  const m =
    // Quoted, the form the original parse handled.
    goal.match(/\btitled?\s+["'“”]([^"'“”]{1,80})["'“”]/i)
    // Explicit `title:` / `title=` key, optionally quoted.
    || goal.match(/\btitle[d]?\s*[:=]\s*["'“”]?([^"'“”\n]{1,80})["'“”]?/i)
    // Bare unquoted token — how goals are actually written in practice
    // ("titled vessel-ts-module-comparison"). The quoted arms returned null for this,
    // so the title silently fell back to a goal-text slug (law 13: a goal must not have
    // to be reworded into the parser's vocabulary). Single token only, so a trailing
    // prose clause is never swallowed into the title. Past tense ONLY: bare "title X"
    // is almost always prose ("...whose title was missing"), and matching it would bind
    // the next word as a note title.
    || goal.match(/\btitled\s+([A-Za-z0-9][\w.\-/]{2,79})\b/i);
  const t = m?.[1]?.trim();
  return t && t.length > 0 ? t : null;
}
