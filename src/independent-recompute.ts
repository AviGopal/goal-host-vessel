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

export type CommandRefusal = { ok: false; reason: string };
export type CommandAccepted = { ok: true };

/**
 * Gate a model-authored recompute command. Refusals name the rule they hit, because a
 * verifier that declines silently is indistinguishable from one that never ran — and this
 * gate's refusals are supposed to be READ, not just obeyed.
 */
export function isReadOnlyShellCommand(raw: string): CommandAccepted | CommandRefusal {
  const cmd = (raw ?? "").trim();
  if (cmd.length === 0) return { ok: false, reason: "empty command" };
  if (cmd.length > 800) return { ok: false, reason: "command too long to audit" };
  if (/\n/.test(cmd)) return { ok: false, reason: "multi-line command — a recompute must be a single auditable line" };
  if (SELF_EMITTED.test(cmd)) return { ok: false, reason: "command EMITS a literal instead of measuring — a self-asserted answer is not evidence" };
  if (REDIRECT.test(cmd)) return { ok: false, reason: "output redirection writes to disk" };
  if (MUTATING_SUBCOMMAND.test(cmd)) return { ok: false, reason: "in-place edit or history-mutating subcommand" };
  if (MUTATING.test(cmd)) return { ok: false, reason: "mutating command" };
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
export function reconcileDerivations(a: number | null, b: number | null): { truth: number } | { truth: null; reason: string } {
  if (a === null || b === null) return { truth: null, reason: "only one derivation produced a usable measurement" };
  if (a !== b) return { truth: null, reason: `two independent derivations disagree (${a} vs ${b}) — neither is ground truth` };
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
