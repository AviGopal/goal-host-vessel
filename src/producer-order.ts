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

/**
 * Per-shape producer cache from a discovery vesselRegistry dump: every row with a
 * non-empty endpoint, listed under each string shape it advertises, ordered by
 * orderProducers. Rows are kept whole (origin, protocol, multiaddr), so the walk
 * routes a cached row exactly as it routes a discovery row.
 *
 * Failure mode this guards: the cache kept ONE endpoint per shape, last registry
 * row winning, and the walk returned it before consulting discovery — so a local
 * producer lost to an overlay row listed after it.
 */
export function buildShapeProducerCache<T extends ProducerRow & { shapes?: unknown }>(rows: readonly T[]): Map<string, T[]> {
  const byShape = new Map<string, T[]>();
  for (const row of rows) {
    if (typeof row.endpoint !== "string" || !row.endpoint) continue;
    if (!Array.isArray(row.shapes)) continue;
    for (const s of row.shapes) {
      if (typeof s !== "string" || !s) continue;
      const list = byShape.get(s);
      if (list) { if (!list.includes(row)) list.push(row); } else byShape.set(s, [row]);
    }
  }
  for (const [s, list] of byShape) byShape.set(s, orderProducers(list));
  return byShape;
}

/**
 * The walk's pick over an ordered producer list. Rows without an endpoint are
 * skipped. A local loopback row is probed (probe false or throwing = dead) and,
 * when dead, the pick falls through to the next row; any other row (a local row
 * on a non-loopback host, an overlay or peer row) is accepted unprobed, since its
 * reachability is mediated by the relay/gateway. When every candidate was a dead
 * local row, the first one is returned — never below the status quo. Empty: null.
 */
export async function pickProducerRoute<T extends ProducerRow, R>(
  rows: readonly T[],
  routeFor: (row: T) => R,
  probe: (endpoint: string) => Promise<boolean>,
): Promise<R | null> {
  let first: R | null = null;
  for (const row of rows) {
    if (typeof row?.endpoint !== "string" || !row.endpoint) continue;
    const route = routeFor(row);
    if (!(producerClass(row) === 0 && isLoopbackEndpoint(row.endpoint))) return route;
    if (first === null) first = route;
    try {
      if (await probe(row.endpoint)) return route;
    } catch { /* dead candidate — try the next producer of this shape */ }
  }
  return first;
}
