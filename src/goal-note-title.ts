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
