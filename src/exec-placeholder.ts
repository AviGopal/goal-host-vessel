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
 * Interpreters whose INPUT (stdin or argv) is a PROGRAM: a pool value reaching one is parsed as
 * code, so any command that invokes one (as its own command word or piped into one) and also
 * carries a placeholder is refused. Command wrappers that pass through to a real command word are
 * skipped first so `sudo sh …` is still seen as `sh`.
 */
export const INTERPRETER_COMMANDS = new Set<string>([
  "sh", "bash", "dash", "zsh", "ksh", "ash", "csh", "tcsh",
  "eval", "source", ".", "exec", "xargs", "env", "su",
  "python", "python2", "python3", "perl", "ruby", "node", "bun", "deno", "php", "lua",
  "osascript", "ssh", "awk", "gawk", "mawk", "nawk", "jq", "yq", "sed", "find",
]);

/** Pass-through wrappers skipped to find the real command word. */
const WRAPPER_COMMANDS = new Set<string>([
  "sudo", "nice", "nohup", "timeout", "time", "command", "builtin", "stdbuf", "ionice", "setsid",
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
function lex(cmd: string): { placeholders: Placeholder[]; segments: Segment[] } | { fatal: string } {
  const placeholders: Placeholder[] = [];
  const segments: Segment[] = [];
  let quote: Quote = "none";
  // Nesting that makes a placeholder re-evaluated as code; any open one refuses a placeholder.
  let backtick = 0, dollarParen = 0, arithmetic = 0, paramExpansion = 0, dblBracket = 0;
  let comment = false;
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
  return { placeholders, segments };
}

/** The resolved command word of a segment (wrappers skipped), lower-cased basename, or null. */
function commandWordOf(seg: Segment): string | null {
  for (const w of seg.words) {
    if (w.hasAssignmentPrefix) continue; // leading NAME=val assignment, not the command
    if (w.text.includes("{{")) return null; // placeholder IS the command word → caller refuses
    const base = w.text.split("/").pop() ?? w.text;
    const lower = base.toLowerCase();
    if (WRAPPER_COMMANDS.has(lower)) continue;
    return lower;
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
  const lexed = lex(cmd);
  if ("fatal" in lexed) return { ok: false, reason: `exec-placeholder: refused — ${lexed.fatal}` };
  const { placeholders, segments } = lexed;

  // Only placeholders with a KNOWN shape and a non-null value are spliced; the rest stay literal
  // and cannot carry a value, so they impose no safety constraint.
  const active = placeholders.filter((p) => p.sh in vars && _valForPlaceholder(vars[p.sh], p.field) != null);
  if (active.length === 0) return { ok: true, command: cmd };

  // (1) context refusals recorded during lexing
  for (const p of active) if (p.refuse) return { ok: false, reason: `exec-placeholder: refused — ${p.refuse} carrying ${p.sh}` };

  // (2) a placeholder that is (part of) the command word, or part of a NAME=value assignment word,
  // or an argument to / piped into a program interpreter, is refused.
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (!seg.hasPlaceholder) continue;
    if (!seg.words.some((w) => w.text.includes("{{") && active.some((a) => a.start >= w.start && a.end <= w.end))) continue;
    // command-word / assignment-word
    let sawCommand = false;
    for (const w of seg.words) {
      const inWord = active.some((a) => a.start >= w.start && a.end <= w.end);
      if (w.hasAssignmentPrefix) { if (inWord) return { ok: false, reason: "exec-placeholder: refused — placeholder in an assignment word" }; continue; }
      if (!sawCommand) {
        const base = (w.text.split("/").pop() ?? w.text).toLowerCase();
        if (WRAPPER_COMMANDS.has(base) && !inWord) continue;
        if (inWord) return { ok: false, reason: "exec-placeholder: refused — placeholder in command-word position" };
        sawCommand = true;
      }
    }
    // interpreter as this segment's own command word
    const cw = commandWordOf(seg);
    if (cw && INTERPRETER_COMMANDS.has(cw)) return { ok: false, reason: `exec-placeholder: refused — placeholder reaches the program of '${cw}'` };
    // piped into a downstream interpreter (stdin becomes its program)
    for (let t = s + 1; t < segments.length && segments[t].pipeFromPrev; t++) {
      const dcw = commandWordOf(segments[t]);
      if (dcw && INTERPRETER_COMMANDS.has(dcw)) return { ok: false, reason: `exec-placeholder: refused — value piped into '${dcw}'` };
    }
  }

  // (3) safe splice: rebuild left-to-right, closing/reopening the surrounding quote correctly.
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
 * Back-compat shim for callers that want the string form. Returns the spliced command, or—on a
 * refusal—the ORIGINAL command unchanged, so a caller that cannot act on a refusal does not run a
 * guessed-at command. Callers that CAN handle a refusal should use spliceExecPlaceholders.
 */
export const interpolateExecPlaceholders = (cmd: string, vars: Record<string, unknown>): ExecSplice =>
  spliceExecPlaceholders(cmd, vars);
