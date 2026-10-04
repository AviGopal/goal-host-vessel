/**
 * Producer ordering for the walk's endpointForShape.
 *
 * Invariant: a shape served on this node is tried before the same shape reached
 * over the overlay or a peer. Discovery returns every producer of a shape; the
 * walk tries them in the order returned here, so this order decides whether a
 * resolve stays local or crosses the relay.
 *
 * Classes, in order (discovery order is kept within each class):
 *   0 local   — origin "local", or no remote marker and a loopback host
 *   1 remote  — origin "overlay" / "peer:<origin>", protocol "libp2p", or
 *               discoveredVia "peer"
 *   2 other   — anything else (a non-loopback host with no origin, or no
 *               parseable endpoint)
 *
 * A remote marker wins over a loopback host: a peer row can carry the peer's own
 * 127.0.0.1 endpoint, which is not local to this node.
 *
 * Failure mode this guards: the previous comparator put NON-loopback rows first
 * and the caller returned the first of those without probing, so a local
 * producer lost to an overlay facade for the same shape.
 */

export interface ProducerRow {
  endpoint?: string;
  origin?: string;
  protocol?: string;
  discoveredVia?: string;
}

/** Loopback hostnames: localhost, ::1 (bare or bracketed, as URL.hostname keeps it), 127.0.0.0/8. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/** Loopback test on a full endpoint URL; false when it is missing or unparseable. */
export function isLoopbackEndpoint(endpoint: string | undefined): boolean {
  if (typeof endpoint !== "string" || !endpoint) return false;
  try {
    return isLoopbackHost(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

function isRemote(row: ProducerRow): boolean {
  const origin = typeof row.origin === "string" ? row.origin : "";
  return origin === "overlay" || origin.startsWith("peer:") || row.protocol === "libp2p" || row.discoveredVia === "peer";
}

export function producerClass(row: ProducerRow): 0 | 1 | 2 {
  if (row.origin === "local" && !isRemote(row)) return 0;
  if (isRemote(row)) return 1;
  return isLoopbackEndpoint(row.endpoint) ? 0 : 2;
}

/** Returns a new array: local rows, then overlay/peer rows, then the rest; input untouched. */
export function orderProducers<T extends ProducerRow>(rows: readonly T[]): T[] {
  const buckets: [T[], T[], T[]] = [[], [], []];
  for (const row of rows) buckets[producerClass(row)].push(row);
  return [...buckets[0], ...buckets[1], ...buckets[2]];
}
