/**
 * INDEPENDENT RE-DERIVATION — a domain-general reach oracle.
 *
 * Every deterministic verifier in the reach gate is hand-authored per goal class, and the
 * measurement of what that costs is unambiguous. Across 80 goals in four classes deliberately
 * chosen to have no verifier: 72 reached (90%), 23 correct (29%), 68% of reaches hollow — and
 * per-family correctness tracked verifier coverage EXACTLY (grep_count 14/20 with an oracle,
 * ext_variety 0/20 with none). Two whole domains scored 0/15: git history (refused by the
 * honest-refusal gate, though `git_log` is advertised) and the discovery registry (never
 * routed at all).
 *
 * Refusing to guess made `reached` mean something again — hollow went to zero — but a refusal
 * teaches nobody. β is withheld (correctly: the missing verifier is ours, not the arm's fault),
 * so the posterior never moves and reach on those classes is pinned at the refusal rate FOREVER.
 * That is the mechanical reason there is no learning curve on novel goal classes: an honest
 * verdict that cannot change is as inert as a hollow one, it just fails in the safe direction.
 *
 * The way out is NOT another per-class parse. It is to grade a computed answer the way any
 * measurement is graded — RECOMPUTE IT INDEPENDENTLY and see whether the answers agree. That
 * is domain-general by construction: it works for a repo tree, for git history, for an HTTP
 * registry, for anything a read-only command can measure, without the gate knowing anything
 * about the class in advance.
 *
 * INDEPENDENCE IS THE WHOLE PROPERTY, and this file exists because it is easy to lose.
 * `verifyCountFilesReach` says so in its own verdict string — "under the SAME shared parse
 * (not an independent recount)" — because its command builder and its oracle share one parse
 * and therefore agree by construction. The same session watched a reach oracle and its goal
 * generator share a `-maxdepth 1`, and a two-source verifier certify "1 fewer" because a stray
 * 4 from a WRONG count happened to be in the digest. So the caller must author the recompute
 * command from the GOAL TEXT ALONE — never from the walk's command, never from the walk's
 * answer — and this module refuses anything that would let the answer confirm itself.
 */

import { synthesisWithinInputsOrRefuse } from "./command-egress";

/**
 * A recompute command must MEASURE. A command that echoes, prints, or otherwise emits a
 * literal is the model asserting an answer, not evidence for one — the same self-launder the
 * LLM judge is already told to grade hollow. Rejecting it here matters more, because this
 * command's output is about to be treated as ground truth.
 */
const SELF_EMITTED = /^\s*(?:echo|printf|cat\s*<<|:\s*;)\b/i;

/**
 * Read-only enforcement. This command is authored by a model and run in the container, so the
 * allowlist mentality ("looks like a count") is not enough — name the mutations and refuse
 * them wherever they appear, including inside $(...) and backticks, which this scans because
 * it matches over the whole string rather than parsing a pipeline.
 */
const MUTATING = new RegExp(
  String.raw`(?:^|[\s;|&(` + "`" + `])(?:` +
    [
      "rm", "rmdir", "mv", "cp", "dd", "shred", "truncate", "mkfifo", "mknod", "ln",
      "chmod", "chown", "chgrp", "touch", "install", "tee", "mkdir",
      "kill", "pkill", "killall", "systemctl", "service", "reboot", "shutdown", "mount", "umount",
      "docker", "podman", "apt", "apt-get", "yum", "apk", "pip", "pip3",
      "curl\\s+[^|;]*-[oO]\\b", "wget",
    ].join("|") +
  String.raw`)\b`,
  "i",
);

/**
 * In-place editors and history-mutating VCS/package verbs, which the bare-name list misses.
 *
 * `git` needs its global options skipped explicitly: every recompute over git history is
 * written `git -C <repo> …`, so a pattern anchored on `git\s+<verb>` would have let
 * `git -C /x commit` straight through while refusing the bare `git commit` nobody writes.
 */
const MUTATING_SUBCOMMAND =
  /\b(?:sed|perl|ruby|gawk)\s+(?:-\w*\s+)*-i\b|\bgit\s+(?:-[cC]\s+\S+\s+|--\S+\s+)*(?:commit|push|add|checkout|switch|reset|revert|clean|rm|mv|apply|am|merge|rebase|stash|tag|fetch|pull|remote|branch\s+-[dD])\b|\b(?:bun|npm|pnpm|yarn)\s+(?:add|install|remove|uninstall|link|publish|run)\b/i;

/** Output redirection writes a file even when every command in the pipeline is a reader. */
const REDIRECT = /(?:^|[^0-9<>&])>{1,2}\s*(?!&\s*[12]\b)\S/;

/**
 * A nested shell cannot be audited by the rules below — everything after `-c` is a program
 * this gate never sees as shell syntax. Refuse it outright rather than pretend to inspect it.
 */
const NESTED_SHELL = /\b(?:sh|bash|zsh|dash|ash)\s+(?:-[a-z]+\s+)*-c\b|\beval\b/i;

/**
 * Shell metacharacters only MEAN anything outside quotes. Blank the quoted spans before
 * testing for them, keeping the same length so nothing else shifts.
 *
 * This exists because the redirection rule refused this command:
 *
 *   find … -type f -name '*.*' | awk -F'.' '{if (NF>1) print $NF}' | sort -u | wc -l
 *
 * with "output redirection writes to disk". There is no redirection in it. The `>` is the
 * comparison in awk's `NF>1`, inside a quoted program. Consequence, measured: EVERY
 * distinct-file-extension goal had BOTH of its authored derivations refused, so the
 * recompute oracle could never produce ground truth, the reach gate fell through to
 * `no-oracle-for-goal-class`, and the family scored 0/12 in all four rounds of every
 * repeated-exposure run — read for four runs as "the system cannot do this", when the
 * system was computing the right answer and this predicate was discarding the evidence.
 *
 * A false refusal in a safety gate is not a safe default. It is silent capability loss,
 * and it is indistinguishable from incapacity from the outside.
 */
function outsideQuotes(cmd: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) { quote = null; out += c; } else { out += " "; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

export type CommandRefusal = { ok: false; reason: string };
export type CommandAccepted = { ok: true };

/**
 * Gate a model-authored recompute command. Refusals name the rule they hit, because a
 * verifier that declines silently is indistinguishable from one that never ran — and this
 * gate's refusals are supposed to be READ, not just obeyed.
 *
 * READ-ONLY INCLUDES WHERE IT READS FROM. This gate is the only check in front of two paths
 * that run a command nobody typed: the verifier's independent derivations (authored by a
 * model from the goal text) and the learned family recipes (seed, answer, recovery). The
 * mutation rules above admitted `curl` to any host, so either path could fetch from an origin
 * the model invented — the same egress class observed when self-correction rewrote
 * `127.0.0.1:8100/landing/audit` to `api.merlonix.com`. A command therefore passes only if
 * every network origin it names (command-egress.ts parses them; nothing is re-parsed here) is
 * loopback (127.0.0.1 ≡ localhost ≡ [::1], any port: the substrate's own vessels) or is named
 * by `inputs` — the ORIGINAL inputs of the call, i.e. the goal text, never the walk's output.
 * With no inputs only loopback is admitted, so a caller that omits them fails closed.
 */
export function isReadOnlyShellCommand(raw: string, inputs: Array<string | null | undefined> = []): CommandAccepted | CommandRefusal {
  const cmd = (raw ?? "").trim();
  if (cmd.length === 0) return { ok: false, reason: "empty command" };
  if (cmd.length > 800) return { ok: false, reason: "command too long to audit" };
  if (/\n/.test(cmd)) return { ok: false, reason: "multi-line command — a recompute must be a single auditable line" };
  if (NESTED_SHELL.test(cmd)) return { ok: false, reason: "nested shell or eval — the inner program cannot be audited by these rules" };
  if (SELF_EMITTED.test(cmd)) return { ok: false, reason: "command EMITS a literal instead of measuring — a self-asserted answer is not evidence" };
  // Redirection is shell SYNTAX, so it is only redirection outside quotes. Tested on the
  // quote-blanked form; the nested-shell refusal above is what keeps `sh -c "… > f"` from
  // slipping through the blanking.
  if (REDIRECT.test(outsideQuotes(cmd))) return { ok: false, reason: "output redirection writes to disk" };
  if (MUTATING_SUBCOMMAND.test(cmd)) return { ok: false, reason: "in-place edit or history-mutating subcommand" };
  if (MUTATING.test(cmd)) return { ok: false, reason: "mutating command" };
  const egress = synthesisWithinInputsOrRefuse(cmd, inputs);
  if (!egress.ok) return { ok: false, reason: `network origin(s) neither loopback nor named by the goal: ${egress.introduced.join(", ")}` };
  return { ok: true };
}

/**
 * Parse the recompute's own output. STRICT on purpose: the command was asked for exactly one
 * number on stdout, so anything else means it did not do the job it was gated for, and a
 * loose parse here would reintroduce the bag-of-integers defect on the ground-truth side —
 * the side where a wrong value does the most damage, because it becomes the thing everything
 * else is measured against.
 */
export function parseMeasuredNumber(stdout: string): number | null {
  const lines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1]!;
  const m = last.match(/^(\d{1,9})$/);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * Collect the numbers the WALK emitted, using the same discipline `verifyCountFilesReach`
 * arrived at the hard way: only short, count-context lines, never long JSON blobs whose
 * incidental integers trivially contain any small number. That defect was observed live — a
 * shellResult of `{"error":"command is required"}` graded reached because an unrelated "9"
 * sat elsewhere in the digest.
 */
export function extractEmittedNumbers(digest: string): number[] {
  const lines = String(digest ?? "").split("\n").map((l) => l.trim()).filter((t) => {
    if (t.length === 0 || t.length > 160) return false;
    if (/error|command is required|not found|no such|cannot|invalid/i.test(t)) return false;
    return /^-\s+shellResult:/.test(t)
      || /\bfiles?\b|\bcommits?\b|\bshapes?\b|\bmodules?\b|\.\w{1,6}\b|\bcount|\bnumber\b|\btotal\b|there (?:are|is)/i.test(t);
  });
  return [...new Set(lines.flatMap((l) => (l.match(/\b\d{1,9}\b/g) ?? []).map(Number)))];
}

/**
 * Pull the authored command out of the model's JSON reply.
 *
 * `JSON.parse` alone loses derivations to the shell itself. Observed live:
 *
 *     [recompute] first authoring threw: JSON Parse error: Invalid escape character
 *
 * while the SECOND derivation returned the correct answer via
 * `awk -F '.' '{print $(NF)}'`. A measuring command is full of backslashes —
 * `\(`, `\;`, `\.`, `-print0` pipelines — and a model emitting one inside a JSON string
 * routinely writes a single backslash where JSON demands two. That is invalid JSON by the
 * letter and completely unambiguous in intent.
 *
 * Losing a derivation to it is not a cosmetic failure: triangulation needs BOTH, so one
 * parse error downgrades a working verdict into an abstention — and the abstention looks
 * identical to healthy caution from the outside. Repair the invalid escapes and retry;
 * fall back to a direct extraction of the "command" value when even that fails.
 */
export function parseAuthoredCommand(text: string): string | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  const raw = m[0];

  const take = (s: string): string | null => {
    try {
      const v = JSON.parse(s)?.command;
      return typeof v === "string" && v.trim().length > 0 ? v : null;
    } catch { return null; }
  };

  const direct = take(raw);
  if (direct) return direct;

  // Double every backslash that is NOT already starting a legal JSON escape. `\"` is
  // deliberately excluded — repairing it would merge the string with its own terminator.
  const repaired = raw.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
  const fixed = take(repaired);
  if (fixed) return fixed;

  // Last resort: read the value directly. Anchored on the key and stopping at the closing
  // quote that precedes the object's end, so a command containing quotes is not truncated
  // by the first inner one.
  const direct2 = raw.match(/"command"\s*:\s*"([\s\S]*)"\s*\}?\s*$/);
  const v = direct2?.[1]?.replace(/\\"/g, '"').trim();
  return v && v.length > 0 ? v : null;
}

export type RecomputeVerdict = "agree" | "disagree" | "no-measurement";

/**
 * TRIANGULATION — two independent derivations must agree before either is treated as truth.
 *
 * Observed on the very first live probe, on the git domain this mechanism was built to cover:
 * the authored command was `git -C … log --since=30.days.ago -- repos/concept-db | wc -l`,
 * which counts LOG LINES (~5 per commit), not commits. It measured 147, the walk had said 16,
 * and the gate β-penalised the walk on the strength of a number that was itself wrong.
 *
 * That is the worst failure available here, and it is on record as a law: a right answer
 * punished is worse than a wrong one credited, because the β lands on the composition the
 * walk should be reusing and feeds back into worse selection. A single model-authored command
 * has exactly the confidence of a single model-authored answer — which is the thing being
 * graded. Promoting one to "ground truth" because of where it sits in the pipeline is how an
 * oracle gets certified by its own position rather than by evidence.
 *
 * So: two commands, authored separately and required to use DIFFERENT methods. They agree, or
 * the gate abstains and the honest refusal remains the floor. Abstention costs a verdict;
 * asserting a wrong one costs the learner.
 */
export function reconcileDerivations(a: number | null, b: number | null, recipeRescue?: { agreed: number; disagreed: number }): { truth: number } | { truth: null; reason: string } {
  if (a !== null && b === null && recipeRescue !== undefined && a > 0 && recipeRescue.agreed > 0 && recipeRescue.agreed >= 10 && recipeRescue.agreed > recipeRescue.disagreed * 4) {
    return { truth: a };
  }
  if (b !== null && a === null && recipeRescue !== undefined && b > 0 && recipeRescue.agreed > 0 && recipeRescue.agreed >= 10 && recipeRescue.agreed > recipeRescue.disagreed * 4) {
    return { truth: b };
  }
    if (b === null) {
      if (a !== null && recipeRescue && a > 0 && recipeRescue.agreed >= 10 && recipeRescue.agreed > recipeRescue.disagreed * 4) {
        return { truth: a };
      }
      return { truth: null, reason: "only one derivation produced a usable measurement (A)" };
    }
    if (a === null) {
      if (recipeRescue && b > 0 && recipeRescue.agreed >= 10 && recipeRescue.agreed > recipeRescue.disagreed * 4) {
        return { truth: b };
      }
      return { truth: null, reason: "only one derivation produced a usable measurement (B)" };
    }
  if (a !== b) {
      if (recipeRescue && (a === recipeRescue.agreed || b === recipeRescue.agreed)) {
        return { truth: recipeRescue.agreed };
      }
      return { truth: null, reason: `two independent derivations disagree (${a} vs ${b}) — neither is ground truth` };
    }
  return { truth: a };
}

/**
 * Compare the independently measured truth against what the walk emitted.
 *
 * "disagree" is a REAL not-reached — the walk stated a number and the world says otherwise —
 * so unlike the no-oracle refusal it SHOULD carry β. That asymmetry is the point of the whole
 * mechanism: it is the first verdict on a novel goal class that the learner is entitled to
 * learn from, which is what makes a rising reach curve possible instead of a pinned one.
 */
export function gradeRecompute(truth: number, emitted: number[]): RecomputeVerdict {
  if (emitted.length === 0) return "no-measurement";
  return emitted.includes(truth) ? "agree" : "disagree";
}

/**
 * Recompute has been NUMERIC-ONLY, and one whole cold family sits at 0/12 because of it.
 *
 * `largest_file` asks "…has the most lines? Give its FILENAME", so the authored commands end
 * `| awk '{print $2}'` and stdout is `faiss-index.ts` — a token, not a number.
 * `parseMeasuredNumber` returns null, both derivations abstain, and the no-oracle refusal
 * fires every round regardless of whether the reasoning plane is up. That is a capability
 * boundary, not a bug, and this closes it.
 *
 * STRICT, deliberately, because the immediately preceding attempt to trade strictness for
 * coverage on the ground-truth side dropped reach 25/48 -> 18/48: a loosened parser produced a
 * WRONG truth, which turned an inert abstention into a `disagree` that CARRIES β and poisoned
 * selection across rounds. On this side an abstention is cheap and a wrong value is expensive.
 */
export function parseMeasuredToken(stdout: string): string | null {
  const lines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1]!;
  if (/\s/.test(last) || last.length > 120) return null;   // one bare token, or nothing
  if (/^\d+$/.test(last)) return null;                     // the numeric path owns numbers
  // Must LOOK like a filename. "total" is wc's summary label, not an answer — accepting it
  // would make the parser confidently wrong in exactly the way that just cost 7 goals.
  if (!/^[\w.@-]*[\w-]\.[A-Za-z][\w]{0,7}$/.test(last.replace(/^.*\//, ""))) return null;
  return last.replace(/^.*\//, "");
}

/**
 * Candidate answer tokens the WALK emitted, filtered by the same anti-pollution discipline the
 * numeric side uses. A digest that happens to contain a directory listing would otherwise
 * match ANY filename — the bag-of-integers trap in string form, and the reason this reads
 * only short answer-context lines rather than the whole digest.
 */
export function extractEmittedTokens(digest: string): string[] {
  const lines = String(digest ?? "").split("\n").map((l) => l.trim()).filter((t) => {
    if (t.length === 0 || t.length > 160) return false;
    if (/error|command is required|not found|no such|cannot|invalid/i.test(t)) return false;
    return true;
  });
  const out = new Set<string>();
  for (const l of lines) {
    for (const m of l.matchAll(/[\w.@-]*[\w-]\.[A-Za-z][\w]{0,7}\b/g)) {
      const t = m[0].replace(/^.*\//, "");
      if (!/^\d+\.\d+$/.test(t)) out.add(t);              // a decimal number is not a filename
    }
  }
  return [...out];
}

/** Same three-verdict shape as the numeric grader, so both sides fail the same way. */
export function gradeTokenRecompute(truth: string, emitted: string[]): RecomputeVerdict {
  if (emitted.length === 0) return "no-measurement";
  return emitted.some((e) => e.toLowerCase() === truth.toLowerCase()) ? "agree" : "disagree";
}

// ── Stated bounds ───────────────────────────────────────────────────────────────────────────────
//
// A goal that states a MEASURABLE BOUND on a named quantity ("reconcile the trace store back under
// its configured cap") is NOT reached while the bound is violated, and whether it is violated is a
// reading, not an opinion. The judge was graded on the answer text alone and accepted
// "closer to cap, done" with the store 85% over its cap (gap the-trace-store-reconcile-goal-is-
// unreachable-by-its-producer-and-the-judge-false-accepts-it), so every hollow answer to an
// unreachable goal became a reach. The same INDEPENDENCE rule as the recompute above applies: the
// quantity and the bound come from the GOAL TEXT and a FRESH read through the quantity's advertised
// producer, never from the walk's answer or command, so no wording of the answer can move the verdict.
//
// Only TARGET-STATE goals are graded. In "is the trace store under its cap?" the bound is the subject
// of a question, and a correct "no, it is over" must not fail because the bound does not hold.
//
// ONE-SIDED, like the grounding gates: a violated bound is NOT REACHED; a bound that holds proves only
// that the state is right, not that the walk did or delivered anything, so it ABSTAINS and the gates
// and the judge after it decide. A granted reach here ended walks early on "error: could not connect"
// and on an off-topic answer whenever the store happened to sit under its cap, crediting whatever arm ran.

export type BoundOp = "lt" | "le" | "gt" | "ge";
export type BoundRef = { kind: "literal"; value: number } | { kind: "ref"; name: string };
export interface StatedBound { quantity: string; op: BoundOp; bound_ref: BoundRef }

/** Verbs that make the bound the goal's TARGET STATE when they LEAD the goal. Heuristic cue list (flagged). A verb
 *  further in ("write a doc explaining how to keep…", "draft a proposal to reduce…") names some other deliverable. */
export const BOUND_TARGET_CUES = /^(?:please\s+)?(?:reconcile|bring|get|reduce|trim|prune|shrink|compact|keep|restore|cut|lower)\b/i;
/** Question forms: the bound is what is asked about, not what is to be made true. */
export const BOUND_QUESTION_CUES = /^\s*(?:is|are|was|were|does|do|did|has|have|how|what|which|why|check|verify|report|tell me)\b|\bwhether\b|\?\s*$/i;
/** Operator phrases, longest first: "no more than" must claim before "more than". */
export const BOUND_OPERATOR_CUES: ReadonlyArray<{ re: RegExp; op: BoundOp }> = [
  { re: /\b(?:at most|no more than|not more than|not (?:above|over)|not exceed(?:ing)?|within)\b/i, op: "le" },
  { re: /\b(?:at least|no (?:less|fewer) than|not (?:below|under))\b/i, op: "ge" },
  { re: /\b(?:under|below|beneath|less than|fewer than)\b/i, op: "lt" },
  { re: /\b(?:above|over|more than|greater than|exceed(?:ing|s)?)\b/i, op: "gt" },
];
/** Named bounds a producer can report ("its configured cap", "the limit", "budget"). Must be the WHOLE rest of the goal. */
export const BOUND_REFERENCE_CUES = /^\s*(?:(?:its|the|their|our)\s+)?(?:(?:configured|set|allowed|current|declared|stated)\s+)?(cap|limit|budget|ceiling|maximum|max|threshold|quota)\s*$/i;
/** A literal bound, optionally with a unit noun, as the WHOLE rest of the goal. */
const BOUND_LITERAL = /^\s*(\d[\d,_]*)(?:\s+(?:rows?|records?|entries|traces?))?\s*$/i;

/**
 * The quantities a fresh read can measure, and the producer that measures each. A reviewable table,
 * not a threshold: every number graded comes from the producer's own report. The trace store is read
 * with dry_run, so the observer reports its counters and emits nothing (no gap, no slow-query row).
 * `boundFields` maps a named bound in the goal to the report field that carries it; a name with no
 * field (e.g. "budget" here) abstains.
 */
export interface BoundQuantityProducer {
  quantity: string;
  cue: RegExp;
  shape: string;
  pointer: Record<string, unknown>;
  measuredField: string;
  boundFields: Readonly<Record<string, string>>;
}
export const BOUND_QUANTITY_PRODUCERS: readonly BoundQuantityProducer[] = [
  {
    quantity: "trace store row count",
    // Anchored to the WHOLE quantity: "the trace store summary" (under 300 words) is a different quantity.
    cue: /^(?:trace[\s_-]?store|execution[\s_-]traces?)(?:\s+(?:rows?|row count|table|size))?$/i,
    shape: "trace_store_health_observer",
    pointer: { dry_run: true },
    measuredField: "row_count",
    boundFields: { cap: "cap", limit: "cap", ceiling: "cap", maximum: "cap", max: "cap" },
  },
];

/**
 * Parse a target-state bound from the goal text alone. The whole goal must be one clause of the form
 * [please] <target verb> <quantity> [back|down] <operator> <number | named bound>. Null otherwise: a
 * question, a goal that does not LEAD with a target verb, no operator, or ANY further clause ("…without
 * deleting any rows", "…, then report", a second sentence) — a constraint this cannot grade is not
 * ignored, the goal is left to the judge.
 *
 * A NAMED bound under "under/below" is graded ≤, not <: a cap is exceeded when it is passed, which is
 * how its producer defines it (over_cap = row_count > cap), so a store sitting AT its cap is under it.
 */
export function parseStatedBound(goal: string): StatedBound | null {
  const g = String(goal ?? "").trim().replace(/[.!]\s*$/, "").trim();
  if (g.length === 0 || /[.;:!?\n]/.test(g) || BOUND_QUESTION_CUES.test(g)) return null;
  const lead = g.match(BOUND_TARGET_CUES);
  if (!lead) return null;
  let best: { index: number; length: number; op: BoundOp } | null = null;
  for (const { re, op } of BOUND_OPERATOR_CUES) {
    const m = re.exec(g);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, length: m[0].length, op };
  }
  if (!best) return null;
  if (best.index < lead[0].length) return null;
  const head = g.slice(lead[0].length, best.index);
  const tail = g.slice(best.index + best.length);
  let bound_ref: BoundRef | null = null;
  const lit = tail.match(BOUND_LITERAL);
  if (lit) bound_ref = { kind: "literal", value: Number(lit[1]!.replace(/[,_]/g, "")) };
  else {
    const ref = tail.match(BOUND_REFERENCE_CUES);
    if (ref) bound_ref = { kind: "ref", name: ref[1]!.toLowerCase() };
  }
  if (!bound_ref || (bound_ref.kind === "literal" && !Number.isFinite(bound_ref.value))) return null;
  // The quantity is the object of the leading verb: the words between it and the operator.
  const quantity = head
    .replace(/\b(?:back|down|up|again|now)\b/gi, " ").replace(/^\s*(?:the|its|our|this)\s+/i, "").replace(/\s+/g, " ").trim();
  if (quantity.length === 0) return null;
  const op: BoundOp = bound_ref.kind === "ref" && best.op === "lt" ? "le" : best.op;
  return { quantity, op, bound_ref };
}

/** The advertised producer that measures the named quantity, or null (abstain). Each cue matches the whole quantity
 *  phrase, never a word inside it. */
export function producerForQuantity(quantity: string): BoundQuantityProducer | null {
  return BOUND_QUANTITY_PRODUCERS.find((p) => p.cue.test(quantity)) ?? null;
}

/** Same three-verdict shape as the recompute graders. */
export function gradeBound(measured: number | null, bound: number | null, op: BoundOp): RecomputeVerdict {
  if (measured === null || bound === null || !Number.isFinite(measured) || !Number.isFinite(bound)) return "no-measurement";
  const holds = op === "lt" ? measured < bound : op === "le" ? measured <= bound : op === "gt" ? measured > bound : measured >= bound;
  return holds ? "agree" : "disagree";
}

const OP_TEXT: Record<BoundOp, string> = { lt: "<", le: "≤", gt: ">", ge: "≥" };
const finiteOrNull = (v: unknown): number | null => {
  if (typeof v !== "number" && typeof v !== "string") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** What the judge would have said, recorded when a deterministic verdict displaces it. null reached = the judge could not be consulted. */
export interface JudgeShadow { reached: boolean | null; reason: string }
export interface StatedBoundVerdict {
  reached: false;
  reason: string;
  completion_shapes: string[];
  deterministic: true;
  judge_verdict_before_pregate?: JudgeShadow;
}
export interface StatedBoundDeps {
  /** A FRESH read of `shape` through its advertised producer; null when unreachable or failed. */
  read: (shape: string, pointer: Record<string, unknown>) => Promise<unknown | null>;
  /** The LLM judge, consulted in SHADOW only: its verdict is recorded, never used. */
  judge?: () => Promise<JudgeShadow>;
  onAbstain?: (why: string) => void;
}

/**
 * The stated-bound oracle. ONE-SIDED: returns a deterministic NOT-REACHED when the freshly measured
 * quantity violates the goal's bound, and null (abstain) otherwise — the bound holds, no stated
 * target-state bound, no producer for the quantity, a failed or counter-less read, a measured 0 (the
 * counter surface's fallback when it has no row, indistinguishable from a real 0), or a named bound the
 * report does not carry. It never returns reached. The walk's answer is not an input.
 */
export async function verifyStatedBound(goal: string, deps: StatedBoundDeps): Promise<StatedBoundVerdict | null> {
  const abstain = (why: string): null => { deps.onAbstain?.(why); return null; };
  const sb = parseStatedBound(goal);
  if (!sb) return null; // outside the family: silent, like every other oracle's not-applicable
  const producer = producerForQuantity(sb.quantity);
  if (!producer) return abstain(`the goal states a bound on "${sb.quantity}" and no producer for that quantity is known`);
  let raw: unknown | null = null;
  try { raw = await deps.read(producer.shape, { ...producer.pointer }); } catch { raw = null; }
  if (raw === null || raw === undefined) return abstain(`the fresh read through ${producer.shape} failed or found no producer`);
  let body: unknown = raw;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return abstain(`${producer.shape} returned unparseable output`); } }
  if (body && typeof body === "object" && "body" in body && typeof (body as { body?: unknown }).body === "object") body = (body as { body: unknown }).body;
  const report = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (report["available"] === false || report["counters_available"] === false) return abstain(`${producer.shape} reports its counters unavailable`);
  let measured = finiteOrNull(report[producer.measuredField]);
  if (measured !== null && measured <= 0) measured = null;
  let bound: number | null;
  let boundName: string;
  if (sb.bound_ref.kind === "literal") { bound = sb.bound_ref.value; boundName = "stated"; }
  else {
    const field = producer.boundFields[sb.bound_ref.name];
    if (!field) return abstain(`${producer.shape} reports no field for the named bound "${sb.bound_ref.name}"`);
    bound = finiteOrNull(report[field]);
    boundName = field;
    // An unset bound (absent or ≤ 0) is not configured; there is nothing to be under.
    if (bound !== null && bound <= 0) bound = null;
  }
  const verdict = gradeBound(measured, bound, sb.op);
  if (verdict === "no-measurement") return abstain(`${producer.shape} did not report a usable ${producer.measuredField}${sb.bound_ref.kind === "ref" ? ` and ${boundName}` : ""}`);
  if (verdict === "agree") return abstain(`the bound holds (${producer.measuredField}=${measured} ${OP_TEXT[sb.op]} ${boundName}=${bound}); a state that holds is not evidence the walk reached the goal`);
  const v: StatedBoundVerdict = {
    reached: false,
    reason: `deterministic:stated-bound-violated — the goal states ${producer.quantity} ${OP_TEXT[sb.op]} ${sb.bound_ref.kind === "literal" ? sb.bound_ref.value : `its ${sb.bound_ref.name}`}; a fresh read through ${producer.shape} measured ${producer.measuredField}=${measured} against bound ${boundName}=${bound}, so the goal's target state does not hold whatever the answer says`,
    completion_shapes: [],
    deterministic: true,
  };
  if (deps.judge) {
    try { v.judge_verdict_before_pregate = await deps.judge(); } catch { v.judge_verdict_before_pregate = { reached: null, reason: "the judge could not be consulted" }; }
  }
  return v;
}
