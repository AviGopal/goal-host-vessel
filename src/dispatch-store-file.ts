// THE DISPATCH STORE FILE IS WRITTEN WHOLE OR NOT AT ALL, AND A BAD ONE IS KEPT, NEVER OVERWRITTEN.
//
// The store was a fire-and-forget, non-atomic Bun.write of the whole snapshot (megabytes), and shutdown exited without
// awaiting it. A restart could therefore leave a truncated file; the next boot's restore caught the parse error, started
// EMPTY with no word, and its 5 s persist then wrote that empty store over the file: every record lost (measured: a
// store of 138 records restored nothing after a restart and was overwritten). Now:
//   - writeStoreAtomic writes a temp file in the same directory and renames it over the store, so a reader (or a crash)
//     sees the previous whole file or the new whole file, never a part; writes are serialised, the latest one wins;
//   - readStoreAtBoot distinguishes a MISSING file (first boot: start empty, quietly) from one that exists and cannot be
//     read as a store: that file is moved aside to <path>.corrupt-<ISO> before anything can overwrite it, and the caller
//     logs it loudly.
import { rename, stat, writeFile, readFile, unlink } from "node:fs/promises";

let chain: Promise<void> = Promise.resolve();
let seq = 0;

/** Write `snapshot` to `path` atomically (temp file in the same directory, then rename). Serialised: each write starts
 *  after the previous one settles, so two persists never interleave. Resolves when this write has landed (or failed). */
export function writeStoreAtomic(path: string, snapshot: string): Promise<void> {
  const run = async (): Promise<void> => {
    const tmp = `${path}.tmp-${process.pid}-${++seq}`;
    try {
      await writeFile(tmp, snapshot);
      await rename(tmp, path);
    } catch (err) {
      try { await unlink(tmp); } catch { /* nothing to clean */ }
      throw err;
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => { /* the caller logs; the chain continues */ });
  return p;
}

/** Wait for every write queued so far to settle. */
export function storeWritesSettled(): Promise<void> {
  return chain;
}

export type StoreRead<T> =
  | { status: "missing"; records: [] }
  | { status: "ok"; records: T[] }
  | { status: "corrupt"; records: []; error: string; movedTo: string | null };

/** Read the store at boot. A missing file is a first boot. An existing file that does not parse to an array is moved
 *  aside (never overwritten) and reported; `now` names the copy. */
export async function readStoreAtBoot<T>(path: string, now: Date = new Date()): Promise<StoreRead<T>> {
  try { await stat(path); } catch { return { status: "missing", records: [] }; }
  let error = "";
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (Array.isArray(parsed)) return { status: "ok", records: parsed as T[] };
    error = `not a JSON array (${parsed === null ? "null" : typeof parsed})`;
  } catch (err) {
    error = (err as Error).message;
  }
  const aside = `${path}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
  try { await rename(path, aside); return { status: "corrupt", records: [], error, movedTo: aside }; }
  catch (err) { return { status: "corrupt", records: [], error: `${error}; moving it aside failed: ${(err as Error).message}`, movedTo: null }; }
}
