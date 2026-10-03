// EXEC-PLACEHOLDER INTERPOLATION — threading produced pool-shape content into an executor command.
//
// KEYSTONE (content-threading -> function-composition, 2026-07-27): deterministically
// interpolate {{shape}} / {{shape.field}} placeholders in an executor command with the
// CONTENT of already-produced pool shapes (poolVars). This makes the command that RUNS a
// FUNCTION of threaded input shapes (the LLM chooses only the operator/structure), so the
// resolver sequence is a genuine f(g(x)): correctness reduces to selecting the right activity
// and causality is assignable to the threaded prerequisite shapes.
//
// SECURITY (exec-placeholder-interpolation-ignores-quote-context-so-pool-content-executes-inside-double-quotes):
// the value is pool content — a web search result, a fetched body, an LLM answer — and the
// command is handed to the shell resolver (local-tools, `bash -c`, root in the container). The
// old splice wrapped every value in single quotes regardless of WHERE the placeholder sat:
//   - inside double quotes the single quotes are literal, so `$( )` and backticks in the value run;
//   - inside single quotes they CLOSED the surrounding quote and left the value bare;
//   - inside a nested interpreter (`sh -c "…"`, `| sh`, `eval`, an awk/jq/sed program body) or an
//     arithmetic/backtick/parameter-expansion context the value is parsed AGAIN as code.
// A pool value must never be able to become shell syntax. The splice now lexes the command once,
// records each placeholder's quote context, and either closes/reopens that exact quote around a
// single-quoted value (safe in bare, single- and double-quoted word contexts) or, when the
// context cannot be made safe, REFUSES the whole command. A refusal is handled by the walk the
// same way a resolver failure is (noteRawResolveFailure + fall through), never guessed around.
//
// Fail-closed is the contract: anything the lexer does not fully understand is refused, not spliced.

const _shq = (v: string): string => "'" + v.replace(/'/g, "'\\''") + "'";

const _valForPlaceholder = (raw: unknown, field?: string): string | null => {
  let val: unknown = raw;
  if (field && val && typeof val === "object" && val !== null) val = (val as Record<string, unknown>)[field];
  if (val == null) return null;
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    for (const k of ["content", "stdout", "value", "text", "path", "body"]) if (typeof o[k] === "string") return o[k] as string;
    try { return JSON.stringify(val); } catch { return null; }
  }
  return String(val);
};

/** The outcome of a splice: the command to run, or a named refusal the walk treats as a failure. */
export type ExecSplice =
  | { ok: true; command: string }
  | { ok: false; reason: string };

/**
 * TIER A — interpreters that execute a PROGRAM read from stdin OR argv (and `eval`/`let`, which
 * evaluate a string). A pool value anywhere in a command that invokes one of these can reach the
 * program it runs — piped in, redirected in, or spliced as an argument — so the command is refused
 * when ANY word of ANY segment is one of these. This is a HEURISTIC with a fail-closed lexer
 * behind it: it over-refuses a benign `echo bash` and does not know every interpreter (dc's `!`,
 * `less`/`vim`/`git -c`, `tar --to-command` are off-list); it is deliberately coarse on the
 * safe side. The names are matched by basename, after pass-through wrappers are skipped.
 */
export const TIER_A_INTERPRETERS = new Set<string>([
  "sh", "bash", "dash", "zsh", "ksh", "ash", "csh", "tcsh",
  "eval", "let", "source", ".", "exec", "xargs", "env", "su",
  "python", "python2", "python3", "perl", "ruby", "node", "bun", "deno", "php", "lua",
  "osascript", "ssh",
]);

/**
 * TIER B — interpreters whose PROGRAM is an argv argument (not stdin). A value piped into one of
 * these is DATA, not program (`cat … | jq '.x'` is fine), so these are refused only when they are
 * the command word of the SAME segment that carries the placeholder — i.e. the value is in their
 * own argv, where the program body / expression lives.
 */
export const TIER_B_INTERPRETERS = new Set<string>([
  "awk", "gawk", "mawk", "nawk", "jq", "yq", "sed", "find",
]);

/** Both tiers, for callers/tests that want the whole set. */
export const INTERPRETER_COMMANDS = new Set<string>([...TIER_A_INTERPRETERS, ...TIER_B_INTERPRETERS]);

/**
 * Pass-through wrappers. A segment led by one of these that carries a placeholder is refused
 * outright: finding the wrapped command word means parsing each wrapper's own options (`timeout`
 * takes a duration, `nice -n N`, `sudo -u U`), and getting that wrong lets `timeout 5 {{x}}` run
 * the value as the command. The shell resolver already bounds and roots the command, so the walk
 * has no need to emit its own wrapper around a threaded value.
 */
const WRAPPER_COMMANDS = new Set<string>([
  "sudo", "nice", "nohup", "timeout", "time", "command", "builtin", "stdbuf", "ionice", "setsid", "doas", "chroot", "unbuffer",
]);

type Quote = "none" | "single" | "double";
interface Placeholder { start: number; end: number; sh: string; field?: string; quote: Quote; refuse?: string; }
interface Word { text: string; start: number; end: number; hasAssignmentPrefix: boolean; }
interface Segment { words: Word[]; pipeFromPrev: boolean; hasPlaceholder: boolean; }

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_:]+)(?:\.([a-zA-Z0-9_]+))?\s*\}\}/y;

/**
 * Lex the command once. Returns every placeholder with its quote context (or a per-placeholder
 * refusal when it sits in a context no outer quoting can tame), plus the segment/word structure
 * used to attribute a placeholder to an interpreter's program text.
 */
function lex(cmd: string): { placeholders: Placeholder[]; segments: Segment[]; heredoc: boolean } | { fatal: string } {
  const placeholders: Placeholder[] = [];
  const segments: Segment[] = [];
  let quote: Quote = "none";
  // Nesting that makes a placeholder re-evaluated as code; any open one refuses a placeholder.
  let backtick = 0, dollarParen = 0, arithmetic = 0, paramExpansion = 0, dblBracket = 0;
  let comment = false;
  let heredoc = false; // an unquoted `<<` opens a heredoc whose body may expand a spliced value
  let seg: Segment = { words: [], pipeFromPrev: false, hasPlaceholder: false };
  let word: Word | null = null;
  let wordIsFirstChar = true; // first non-space char of a word, for assignment-prefix detection
  const unsafeCtx = (): string | null =>
    backtick > 0 ? "command-substitution (backtick)"
    : dollarParen > 0 ? "command-substitution $( )"
    : arithmetic > 0 ? "arithmetic expansion"
    : paramExpansion > 0 ? "parameter expansion ${ }"
    : dblBracket > 0 ? "conditional expression [[ ]]"
    : comment ? "comment"
    : null;

  const endWord = () => { word = null; };
  const startSeg = (pipeFromPrev: boolean) => { segments.push(seg); seg = { words: [], pipeFromPrev, hasPlaceholder: false }; endWord(); };

  const n = cmd.length;
  let i = 0;
  while (i < n) {
    const c = cmd[i];

    if (comment) { if (c === "\n") { comment = false; startSeg(false); } i++; continue; }

    if (quote === "single") {
      if (c === "'") { quote = "none"; i++; continue; }
      if (c === "{" && cmd[i + 1] === "{") {
        PLACEHOLDER_RE.lastIndex = i;
        const m = PLACEHOLDER_RE.exec(cmd);
        if (m && m.index === i) {
          if (!word) { word = { text: "", start: i, end: i, hasAssignmentPrefix: false }; seg.words.push(word); }
          const ph: Placeholder = { start: i, end: i + m[0].length, sh: m[1], field: m[2], quote: "single" };
          const u = unsafeCtx();
          if (u) ph.refuse = u;
          placeholders.push(ph);
          seg.hasPlaceholder = true;
          word.text += m[0];
          word.end = i + m[0].length;
          i += m[0].length;
          continue;
        }
      }
      if (word) word.text += c;
      i++;
      continue;
    }
    if (quote === "double") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { return { fatal: "command-substitution (backtick) inside double quotes" }; }
      if (c === "$" && (cmd[i + 1] === "(" || cmd[i + 1] === "{")) { return { fatal: "expansion inside double quotes carrying a placeholder" }; }
      if (c === '"') { quote = "none"; i++; continue; }
      if (c === "{" && cmd[i + 1] === "{") { /* placeholder handled below */ }
      else { if (word) word.text += c; i++; continue; }
    }

    // quote === "none" (or a double-quote placeholder, handled just below)
    // Placeholder?
    if (c === "{" && cmd[i + 1] === "{") {
      PLACEHOLDER_RE.lastIndex = i;
      const m = PLACEHOLDER_RE.exec(cmd);
      if (m && m.index === i) {
        if (!word) { word = { text: "", start: i, end: i, hasAssignmentPrefix: false }; seg.words.push(word); wordIsFirstChar = true; }
        const inDouble = quote === "double";
        const ph: Placeholder = { start: i, end: i + m[0].length, sh: m[1], field: m[2], quote: inDouble ? "double" : "none" };
        const u = unsafeCtx();
        if (u) ph.refuse = u;
        placeholders.push(ph);
        seg.hasPlaceholder = true;
        word.text += m[0];
        word.end = i + m[0].length;
        wordIsFirstChar = false;
        i += m[0].length;
        continue;
      }
      // a lone "{{" that is not a well-formed placeholder: treat "{" literally
    }

    if (quote === "double") { if (word) word.text += c; i++; continue; }

    // unquoted
    switch (c) {
      case "\\": { if (word) word.text += cmd[i + 1] ?? ""; i += 2; continue; }
      case "'": quote = "single"; if (!word) { word = { text: "", start: i, end: i, hasAssignmentPrefix: false }; seg.words.push(word); wordIsFirstChar = true; } i++; continue;
      case '"': quote = "double"; if (!word) { word = { text: "", start: i, end: i, hasAssignmentPrefix: false }; seg.words.push(word); wordIsFirstChar = true; } i++; continue;
      case "#": if (wordIsFirstChar || !word) { comment = true; i++; continue; } break;
      case " ": case "\t": endWord(); wordIsFirstChar = true; i++; continue;
      case "\n": case ";": startSeg(false); wordIsFirstChar = true; i++; continue;
      case "`": backtick = backtick > 0 ? 0 : 1; i++; continue;
    }

    if (c === "$" && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) { return { fatal: "ANSI-C / locale quoting ($' or $\")" }; }
    if (c === "$" && cmd[i + 1] === "(" && cmd[i + 2] === "(") { arithmetic++; i += 3; continue; }
    if (c === "$" && cmd[i + 1] === "(") { dollarParen++; i += 2; continue; }
    if (c === "$" && cmd[i + 1] === "{") { paramExpansion++; i += 2; continue; }
    if (c === "(" && cmd[i + 1] === "(") { arithmetic++; i += 2; continue; }
    if (c === ")" && cmd[i + 1] === ")" && arithmetic > 0) { arithmetic--; i += 2; continue; }
    if (c === ")" && dollarParen > 0) { dollarParen--; i++; continue; }
    if (c === "}" && paramExpansion > 0) { paramExpansion--; i++; continue; }
    if (c === "[" && cmd[i + 1] === "[") { dblBracket++; i += 2; continue; }
    if (c === "]" && cmd[i + 1] === "]" && dblBracket > 0) { dblBracket--; i += 2; continue; }

    if (c === "|") {
      if (cmd[i + 1] === "|") { startSeg(false); i += 2; continue; }
      startSeg(true); i++; continue;
    }
    if (c === "&") {
      if (cmd[i + 1] === "&") { startSeg(false); i += 2; continue; }
      startSeg(false); i++; continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") { startSeg(false); i++; continue; }
    // `<<` opens a heredoc (but `<<<` is a here-STRING, which feeds DATA on stdin, not a body).
    if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") { heredoc = true; endWord(); wordIsFirstChar = true; i += 2; continue; }
    if (c === "<" || c === ">") { endWord(); wordIsFirstChar = true; i++; continue; }

    // ordinary character
    if (!word) { word = { text: "", start: i, end: i, hasAssignmentPrefix: false }; seg.words.push(word); wordIsFirstChar = true; }
    if (c === "=" && wordIsFirstChar === false && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.text)) word.hasAssignmentPrefix = true;
    word.text += c;
    word.end = i + 1;
    wordIsFirstChar = false;
    i++;
  }
  if (quote !== "none") return { fatal: "unterminated quote" };
  if (backtick || dollarParen || arithmetic || paramExpansion || dblBracket) return { fatal: "unterminated expansion" };
  segments.push(seg);
  return { placeholders, segments, heredoc };
}

const basenameOf = (text: string): string => (text.split("/").pop() ?? text).toLowerCase();

/** The command word of a segment (wrappers skipped), its basename, or null when none/placeholder. */
function commandWordOf(seg: Segment): string | null {
  for (const w of seg.words) {
    if (w.hasAssignmentPrefix) continue; // leading NAME=val assignment, not the command
    if (w.text.includes("{{")) return null; // placeholder IS the command word → caller refuses
    const lower = basenameOf(w.text);
    if (WRAPPER_COMMANDS.has(lower)) continue;
    return lower;
  }
  return null;
}

/** The leading (first) word of a segment, wrappers NOT skipped, its basename, or null. */
function leadWordOf(seg: Segment): { base: string; isPlaceholder: boolean } | null {
  for (const w of seg.words) {
    if (w.hasAssignmentPrefix) continue;
    return { base: basenameOf(w.text), isPlaceholder: w.text.includes("{{") };
  }
  return null;
}

/**
 * Interpolate {{shape}} / {{shape.field}} placeholders with produced pool content, quote-context
 * aware and fail-closed. Returns the command on success, or a named refusal when a placeholder
 * sits where no outer quoting can keep the value from becoming shell syntax. Unknown placeholders
 * and null values are left intact (unchanged from the original behaviour).
 */
export function spliceExecPlaceholders(cmd: string, vars: Record<string, unknown>): ExecSplice {
  if (!cmd.includes("{{")) return { ok: true, command: cmd };

  // Resolve which placeholders carry a real value BEFORE lexing. A command whose placeholders are
  // all unknown or null carries no value and so imposes no safety constraint — it is returned
  // UNCHANGED (the pre-fix behaviour), even if it contains a $( ) that the lexer would refuse.
  const bound = (sh: string, field?: string): boolean => sh in vars && _valForPlaceholder(vars[sh], field) != null;
  let anyBound = false;
  for (const m of cmd.matchAll(/\{\{\s*([a-zA-Z0-9_:]+)(?:\.([a-zA-Z0-9_]+))?\s*\}\}/g)) {
    if (bound(m[1], m[2])) { anyBound = true; break; }
  }
  if (!anyBound) return { ok: true, command: cmd };

  const lexed = lex(cmd);
  if ("fatal" in lexed) return { ok: false, reason: `exec-placeholder: refused — ${lexed.fatal}` };
  const { placeholders, segments, heredoc } = lexed;

  const active = placeholders.filter((p) => bound(p.sh, p.field));
  if (active.length === 0) return { ok: true, command: cmd };

  // (1) a heredoc anywhere + a value to splice: an unquoted-delimiter body expands the value, so
  // refuse rather than reason about which body the value lands in.
  if (heredoc) return { ok: false, reason: "exec-placeholder: refused — heredoc body" };

  // (2) context refusals recorded during lexing (backtick / $( / $(( / ${ / [[ / comment)
  for (const p of active) if (p.refuse) return { ok: false, reason: `exec-placeholder: refused — ${p.refuse} carrying ${p.sh}` };

  // (3) TIER A: an interpreter that runs a program from stdin OR argv (or eval/let) appearing as
  // ANY word of ANY segment — the value could be piped, redirected, or spliced into its program.
  for (const seg of segments) {
    for (const w of seg.words) {
      if (w.text.includes("{{") && w.text.replace(/\{\{[^}]*\}\}/g, "").length === 0) continue; // the word IS only a placeholder, handled below
      if (TIER_A_INTERPRETERS.has(basenameOf(w.text))) {
        return { ok: false, reason: `exec-placeholder: refused — command invokes the interpreter '${basenameOf(w.text)}'` };
      }
    }
  }

  // (4) per segment carrying a value: command-word / assignment-word / wrapper-lead / TIER-B.
  for (const seg of segments) {
    const carries = seg.words.some((w) => w.text.includes("{{") && active.some((a) => a.start >= w.start && a.end <= w.end));
    if (!carries) continue;

    // wrapper-led segment with a value: refuse (the wrapped command word cannot be found safely).
    const lead = leadWordOf(seg);
    if (lead && !lead.isPlaceholder && WRAPPER_COMMANDS.has(lead.base)) {
      return { ok: false, reason: `exec-placeholder: refused — placeholder in a segment led by the wrapper '${lead.base}'` };
    }

    // command-word position / assignment word
    let sawCommand = false;
    for (const w of seg.words) {
      const inWord = active.some((a) => a.start >= w.start && a.end <= w.end);
      if (w.hasAssignmentPrefix) { if (inWord) return { ok: false, reason: "exec-placeholder: refused — placeholder in an assignment word" }; continue; }
      if (!sawCommand) {
        if (WRAPPER_COMMANDS.has(basenameOf(w.text)) && !inWord) continue;
        if (inWord) return { ok: false, reason: "exec-placeholder: refused — placeholder in command-word position" };
        sawCommand = true;
      }
    }

    // TIER B: value is in the argv of an interpreter whose program is an argument (awk/jq/sed/…).
    const cw = commandWordOf(seg);
    if (cw && TIER_B_INTERPRETERS.has(cw)) return { ok: false, reason: `exec-placeholder: refused — placeholder reaches the program of '${cw}'` };
  }

  // (5) safe splice: rebuild left-to-right, closing/reopening the surrounding quote correctly.
  let out = "";
  let cursor = 0;
  for (const p of active) {
    out += cmd.slice(cursor, p.start);
    const val = _valForPlaceholder(vars[p.sh], p.field) as string;
    // Bare: a single-quoted token. Double-quoted: CLOSE the " , emit the single-quoted token,
    // REOPEN the " . Single-quoted: we are already inside '…', so emit the value with each inner
    // quote closed/escaped/reopened ('\'') and no wrapping. In every case the value lands as a
    // literal argument, never as shell syntax.
    out += p.quote === "double" ? `"${_shq(val)}"`
      : p.quote === "single" ? val.replace(/'/g, "'\\''")
      : _shq(val);
    cursor = p.end;
  }
  out += cmd.slice(cursor);
  return { ok: true, command: out };
}

/**
 * Alias of spliceExecPlaceholders kept under the original name for tests/callers that import it.
 * Returns the same ExecSplice ({ok:true,command} | {ok:false,reason}); every caller must act on a
 * refusal (a refusal is NOT a command) — the sole production caller (index.ts) does.
 */
export const interpolateExecPlaceholders = (cmd: string, vars: Record<string, unknown>): ExecSplice =>
  spliceExecPlaceholders(cmd, vars);
