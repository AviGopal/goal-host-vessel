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
 */

export interface ReachedCommandEntry {
  command: string;
  field: string;
  shape: string;
  targetShapes: string[];
  goalText: string;
}

interface RawLine {
  hash?: string;
  tombstone?: boolean;
  command?: string;
  field?: string;
  shape?: string;
  targetShapes?: string[];
  goalText?: string;
}

/**
 * Replay JSONL lines into the effective command library.
 *
 * Malformed lines are skipped rather than fatal — a corrupt line must not cost the whole library,
 * and a load failure that starts empty is worse than one that drops a record.
 *
 * Returns the resulting map plus the number of lines that applied, which the caller logs. The
 * count includes tombstones: a boot that applied 40 banks and 12 tombstones did real work on 52
 * lines, and reporting only the survivors would make eviction look like a no-op.
 */
export function applyReachedCommandLines(lines: string[]): {
  entries: Map<string, ReachedCommandEntry>;
  applied: number;
  tombstoned: number;
} {
  const entries = new Map<string, ReachedCommandEntry>();
  let applied = 0;
  let tombstoned = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let e: RawLine;
    try {
      e = JSON.parse(line) as RawLine;
    } catch {
      continue; // skip malformed line
    }
    if (!e.hash) continue;
    if (e.tombstone === true) {
      entries.delete(e.hash);
      applied++;
      tombstoned++;
      continue;
    }
    if (e.command && e.field && e.shape) {
      entries.set(e.hash, {
        command: e.command,
        field: e.field,
        shape: e.shape,
        targetShapes: e.targetShapes ?? [],
        goalText: e.goalText ?? "",
      });
      applied++;
    }
  }

  return { entries, applied, tombstoned };
}
