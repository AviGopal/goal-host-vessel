/**
 * Replay semantics for the append-only reached-command library.
 *
 * WHY THIS IS ITS OWN MODULE (2026-08-16). The store is a JSONL file on the container volume:
 * append on a reach, replay on boot, last-N-wins. The replay is where the interesting behaviour
 * lives, and it was untestable while it sat inline in the vessel's HTTP entrypoint — so the
 * defect below survived unnoticed.
 *
 * THE DEFECT. The loader only ever CREATED entries, so an in-memory `delete` did not survive a
 * restart: a command banked from a reach that later graded FALSE was resurrected byte-identical
 * on the next boot and replayed by the next similar goal. There was no path from "this never
 * worked" to "stop replaying it" that outlived the process — a one-way ratchet, the same shape
 * as the counterfeit Beta sampler fixed earlier in this session, where estimates could only rise.
 *
 * THE FIX. Eviction appends a `{hash, tombstone: true}` marker rather than rewriting the file
 * (append-only is cheap, crash-safe, and free of the read-modify-write race two concurrent walks
 * would otherwise hit). Replay applies entries IN ORDER, so recency resolves bank-vs-tombstone
 * for free: a later re-bank after a genuine reach overrides an earlier tombstone, and a later
 * tombstone overrides an earlier bank.
 *
 * WHAT MAY BE BANKED (the bank basis). A reach the LLM judge alone credited is one observation by
 * a stochastic grader, and banking it turned one wrong "yes" into a recipe replayed on the next
 * attempt — including the retry of the very dispatch whose answer was wrong. An entry is banked
 * only on a DETERMINISTIC oracle's reach, or on two INDEPENDENT observers concurring (two
 * independent derivations agreeing on the same non-degenerate value). The judge re-sampled on the
 * same answer (the verdict-consistency layer) is one observer sampled twice, not two. Every entry
 * carries its `basis`; an entry without one predates the gate, so nothing says it passed it, and
 * it is NOT replayed: it comes back only through a fresh re-bank that does.
 */

/** Why an entry was banked. Absent on entries written before the bank gate; those do not replay. */
export type ReachedCommandBasis = "deterministic" | "concurring";

export interface ReachedCommandEntry {
  command: string;
  field: string;
  shape: string;
  targetShapes: string[];
  goalText: string;
  basis: ReachedCommandBasis;
}

/**
 * The bank gate: the basis to bank a reach under, or null when it must not be banked. A judge-only
 * reach (neither deterministic nor independently concurred) is null.
 */
export function shouldBank(o: { deterministic: boolean; independentConcurring: boolean }): ReachedCommandBasis | null {
  if (o.deterministic) return "deterministic";
  if (o.independentConcurring) return "concurring";
  return null;
}

const isBasis = (b: unknown): b is ReachedCommandBasis => b === "deterministic" || b === "concurring";

/** The bank candidate a walk's reached commands offer: what a bank line carries, before its basis. */
export interface BankCandidate {
  command: string;
  field: string;
  shape: string;
  targetShapes: string[];
  goalText: string;
}

/** The field a command rides in, from its shape's name (sql / script / cmd), else "command". */
export function commandFieldOf(shape: string): string {
  return ["sql", "script", "cmd"].find((f) => new RegExp(`(^|[_-])${f}([_-]|$)`, "i").test(shape)) ?? "command";
}

/** A command whose output differs between sh and bash (`echo` with a backslash escape) is not a reusable recipe. */
export function isShellDependentEcho(cmd: string): boolean {
  return /\becho\b[^|;]*\\[nrt]/.test(cmd);
}

/**
 * THE ONE PICK both bank paths use (the walk's deterministic bank and a person's verdict on a deferred judge-only
 * reach): the first reached command, in the walk's order, that is not shell-dependent, produced a shape the walk
 * produced, and is non-empty. Observe never yields one. `onShellDependent` is told each shell-dependent command
 * skipped before the pick (the walk logs it), in order, exactly as the walk's inline loop did.
 */
export function pickBankCandidate(
  commands: Iterable<[string, string]>,
  producedShapes: ReadonlySet<string>,
  goal: string,
  learningMode: string | undefined,
  onShellDependent?: (shape: string) => void,
): BankCandidate | null {
  for (const [sh, cmd] of commands) {
    if (typeof cmd === "string" && isShellDependentEcho(cmd)) { onShellDependent?.(sh); continue; }
    if (learningMode !== "observe" && producedShapes.has(sh) && typeof cmd === "string" && cmd.trim()) {
      return { command: cmd, field: commandFieldOf(sh), shape: sh, targetShapes: [...producedShapes], goalText: goal };
    }
  }
  return null;
}

/** Provenance a bank line may carry (additive: the loader ignores it). A person's verdict names itself here. */
export interface BankProvenance { decided_by: "person"; label_execution_id: string }

/**
 * The LAST word the store's lines say about `hash`, by the same rule the loader applies (a line with that hash and
 * tombstone true is a tombstone; one with command, field, shape and a basis is a bank). null when the lines say
 * nothing. Read over the lines appended after a mark, it says whether the hash was tombstoned since then.
 */
export function lastWordFor(lines: readonly string[], hash: string): "bank" | "tombstone" | null {
  let word: "bank" | "tombstone" | null = null;
  for (const line of lines) {
    const e = parseLine(line);
    if (!e || e.hash !== hash) continue;
    if (e.tombstone === true) word = "tombstone";
    else if (e.command && e.field && e.shape && isBasis(e.basis)) word = "bank";
  }
  return word;
}

function parseLine(line: string): RawLine | null {
  if (!line.trim()) return null;
  try { return JSON.parse(line) as RawLine; } catch { return null; }
}

/**
 * A banked command whose replay FAILED in this dispatch: the walk replayed it for `shape` and its
 * resolve did not succeed as itself (no result, refused, or rewritten by the walk's correction).
 * In-process only, carried from attempt to attempt of one dispatch.
 *
 * WHY THIS AND NOT AN ABLATION FLAG. A retry after an in-dispatch failure used to run with
 * `ablation.disableReuse`, which turns off EVERY replay: a verified retrieval that ran fine in the
 * failed attempt was thrown away and the retry re-derived it cold. Ablation flags are for
 * counterfactual arms, never for a production dispatch. Only the command that failed is skipped.
 */
export interface FailedReplay {
  shape: string;
  command: string;
  why: string;
}

/**
 * The replays of one walk that failed. `replayed` is shape -> the banked command the walk replayed
 * for it; `succeeded` is the walk's success ledger (shape -> the command a SUCCESSFUL resolve used,
 * written only on success). A replay failed when the ledger does not hold that same command.
 */
export function failedBankReplays(replayed: ReadonlyMap<string, string>, succeeded: ReadonlyMap<string, string>): FailedReplay[] {
  const out: FailedReplay[] = [];
  for (const [shape, command] of replayed) {
    const ran = succeeded.get(shape);
    if (ran === command) continue;
    out.push({ shape, command, why: ran === undefined ? "its replay produced no usable result" : "its replay failed and the walk corrected it to a different command" });
  }
  return out;
}

/** The recorded failure that blocks replaying `command` for `shape` on this attempt, if any. */
export function replayBlocked(failed: readonly FailedReplay[] | undefined, shape: string, command: string): FailedReplay | undefined {
  return (failed ?? []).find((f) => f.shape === shape && f.command === command);
}

interface RawLine {
  hash?: string;
  tombstone?: boolean;
  command?: string;
  field?: string;
  shape?: string;
  targetShapes?: string[];
  goalText?: string;
  basis?: string;
  /** Additive (a person's bank names itself); ignored by the replay. */
  provenance?: unknown;
}

/**
 * Replay JSONL lines into the effective command library.
 *
 * Malformed lines are skipped rather than fatal — a corrupt line must not cost the whole library,
 * and a load failure that starts empty is worse than one that drops a record.
 *
 * Returns the resulting map plus the number of lines that applied, which the caller logs. The
 * count includes tombstones: a boot that applied 40 banks and 12 tombstones did real work on 52
 * lines, and reporting only the survivors would make eviction look like a no-op. `legacy` counts
 * bank lines skipped for carrying no bank basis (written before the bank gate).
 */
export function applyReachedCommandLines(lines: string[]): {
  entries: Map<string, ReachedCommandEntry>;
  applied: number;
  tombstoned: number;
  legacy: number;
} {
  const entries = new Map<string, ReachedCommandEntry>();
  let applied = 0;
  let tombstoned = 0;
  let legacy = 0;

  for (const line of lines) {
    const e = parseLine(line); // a blank or malformed line is skipped
    if (!e) continue;
    if (!e.hash) continue;
    if (e.tombstone === true) {
      entries.delete(e.hash);
      applied++;
      tombstoned++;
      continue;
    }
    if (e.command && e.field && e.shape) {
      // No basis: banked before the gate, on what may have been one judge "yes". Not replayed; an
      // earlier tagged entry for the same hash is left as it was (this line is not evidence).
      if (!isBasis(e.basis)) { legacy++; continue; }
      entries.set(e.hash, {
        command: e.command,
        field: e.field,
        shape: e.shape,
        targetShapes: e.targetShapes ?? [],
        goalText: e.goalText ?? "",
        basis: e.basis,
      });
      applied++;
    }
  }

  return { entries, applied, tombstoned, legacy };
}
