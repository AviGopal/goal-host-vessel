/**
 * Deterministic repairs for LLM-synthesized shell commands.
 *
 * These exist for one failure class: a command whose text the model reads back as correct, but
 * which bash silently reinterprets into something else. The model cannot diagnose these from its
 * own output — it sees the command it meant to write — so a self-correction loop spends its whole
 * budget re-emitting the same defect. Repair them, do not explain them.
 */

/**
 * Single-quote any URL whose query string carries an unquoted `&`.
 *
 * THE OBSERVED FAILURE (2026-08-29). A walk dispatched to diagnose concept-db latency synthesized
 *
 *     curl -s http://127.0.0.1:8260/concepts/search?q=&limit=1 | head -c 4000
 *
 * and got empty stdout SEVEN times. local-tools-vessel runs every command through its
 * `groupBounded` wrapper, which embeds it as `( <command> ) &`. Inside that subshell bash splits
 * the line at the bare `&`, so it runs `curl -s http://…?q=` in the BACKGROUND and treats
 * `limit=1` as a variable assignment. Reproduced directly in the container:
 *
 *     [1]-  Done   ( curl -s http://127.0.0.1:8260/concepts/search?q=test & limit=1 | head -c 200 )
 *
 * — empty stdout, **exit 0**, indistinguishable from "the endpoint returned nothing". The same
 * `[1]-  Done ( curl -s 'https` signature was recorded in a tap comment on 2026-08-15 and read as
 * a curl failure rather than as bash job control.
 *
 * The correction loop cannot escape it: attempts 2-5 of that run logged a BYTE-IDENTICAL command
 * ("WAS: X -> NOW: X"), because the model re-reads `?q=&limit=1` and finds nothing wrong.
 *
 * A URL carrying `?` and `&` inside one unquoted, whitespace-free token is never asking to be
 * backgrounded, so quoting is unambiguous. Single quotes are safe for URLs (no metacharacter
 * inside survives) and the lookbehind makes this a no-op when the model already quoted it.
 *
 * NOT applied to bare `url`/`endpoint` arguments that are fetched directly rather than run through
 * a shell — adding quotes there would embed a literal `'` into the request. Callers restrict this
 * to command-bearing keys.
 */
export function quoteUrlsWithAmpersands(command: string): string {
  return command.replace(/(?<!['"])(https?:\/\/[^\s'"]*\?[^\s'"]*&[^\s'"]*)/g, "'$1'");
}

/** Command-bearing pointer keys — the only args safe to shell-repair. */
export const COMMAND_KEYS = ["command", "cmd", "script", "sql"] as const;
