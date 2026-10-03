/**
 * Quiesce gate: refuse NEW long-running work while pull-sync's marker is present.
 *
 * substrate-pull-sync quiesces a vessel that publishes `drain_ms` before restarting
 * it. It touches $QUIESCE_DIR/<vessel> (default /workspace/quiesce) and waits for
 * /health in_flight to reach zero. That wait ends only if the vessel stops ADMITTING
 * work while the marker exists: close admission and in-flight falls to zero by
 * itself. goal-host published drain_ms, so pull-sync did quiesce it, but goal-host
 * never read the marker. New walks kept arriving, and the restart killed them.
 *
 * The freshness rule is copied from development-vessel's quiesced()
 * (development-vessel src/index.ts, QUIESCE_MARKER / QUIESCE_MAX_MS, at ff9e805f):
 * the marker counts only while its mtime is younger than QUIESCE_MAX_MS (default
 * 20 min). A stale marker fails open, because a converger that died mid-run must
 * not close admission forever. An absent or unreadable marker also fails open.
 *
 * Paths and the bound come from parameters with env defaults that are read at call
 * time, so tests can point the gate at a temp dir. GOAL_HOST_QUIESCE_MARKER is
 * goal-host-specific on purpose: development-vessel reads QUIESCE_MARKER, and one
 * shared container-wide value would point both vessels at the same file.
 *
 * Only ADMISSION is gated. A walk that is already running is never interrupted;
 * /health stays open so the converger can watch in_flight drain.
 */
import { statSync } from "node:fs";

export interface QuiesceOpts {
  marker?: string;
  maxMs?: number;
  now?: number;
}

export function quiesceMarkerPath(): string {
  return process.env["GOAL_HOST_QUIESCE_MARKER"]
    ?? `${process.env["QUIESCE_DIR"] ?? "/workspace/quiesce"}/goal-host-vessel`;
}

export function quiesced(opts: QuiesceOpts = {}): boolean {
  const marker = opts.marker ?? quiesceMarkerPath();
  const envMax = Number(process.env["QUIESCE_MAX_MS"] ?? "");
  const maxMs = opts.maxMs ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : 20 * 60_000);
  try {
    const st = statSync(marker);
    return (opts.now ?? Date.now()) - st.mtimeMs < maxMs;
  } catch {
    return false;
  }
}

/** A retryable 503 when quiesced, else null. Used at the admission point for new walks. */
export function quiesceRefusal(opts: QuiesceOpts = {}): Response | null {
  if (!quiesced(opts)) return null;
  console.log("[goal-host-vessel] REFUSING new walk: quiesced for restart (admission closed); in-flight walks continue, caller should retry");
  return new Response(
    JSON.stringify({
      error: "quiesced",
      quiesced: true,
      retryable: true,
      message: "goal-host is quiesced for a restart and is not admitting new walks; retry shortly",
    }),
    { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "30" } },
  );
}
