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
  peerEndpoint?: string;
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

/** The origin (scheme://host:port, lowercased) of a URL; null when it is missing or unparseable. */
export function urlOrigin(url: string | undefined): string | null {
  if (typeof url !== "string" || !url) return null;
  try { return new URL(url).origin.toLowerCase(); } catch { return null; }
}

/**
 * Returns a new array: local rows, then overlay/peer rows, then the rest; input untouched.
 *
 * OWN SUBSTRATE FIRST among remote rows: when `ownPeers` is given (the discovery origins of this substrate's
 * nodes, from the substrateNodes pool record), a peer row reached through one of them comes before a peer row
 * reached through any other peer. A shape this substrate serves on a sibling node resolves there, with a key
 * the sibling accepts, instead of at a federation peer that validates against its own identity (measured
 * 2026-10-15: a compose node's walk resolves of its landing shapes went to the hub first in discovery order and
 * were refused with 401). Without `ownPeers` the order is unchanged.
 */
export function orderProducers<T extends ProducerRow>(rows: readonly T[], ownPeers?: ReadonlySet<string>): T[] {
  const buckets: [T[], T[], T[]] = [[], [], []];
  for (const row of rows) buckets[producerClass(row)].push(row);
  if (ownPeers && ownPeers.size > 0) {
    const own = (r: T): boolean => { const o = urlOrigin(r.peerEndpoint); return o !== null && ownPeers.has(o); };
    buckets[1] = [...buckets[1].filter(own), ...buckets[1].filter((r) => !own(r))];
  }
  return [...buckets[0], ...buckets[1], ...buckets[2]];
}

/**
 * A peer row resolved at its OWN endpoint. Discovery re-homes a peer's loopback rows onto the peer host, so a
 * peer row whose endpoint is a non-loopback http(s) URL names the producer itself. Its peerEndpoint is the
 * peer's DISCOVERY, which serves no impulse resolve route: resolving there answered 404 (a sibling node's
 * discovery) or 401 (a federation front validating the caller's key against its own identity), measured
 * 2026-10-15. A libp2p row keeps the transport egress; a peer row whose endpoint is loopback or unparseable
 * keeps the caller's other branches.
 */
export function dialsOwnEndpoint(row: ProducerRow): boolean {
  if (row.discoveredVia !== "peer" || row.protocol === "libp2p") return false;
  if (typeof row.endpoint !== "string" || !row.endpoint || isLoopbackEndpoint(row.endpoint)) return false;
  try { const u = new URL(row.endpoint); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

/**
 * Per-shape producer cache from a discovery vesselRegistry dump: every row with a
 * non-empty endpoint, listed under each string shape it advertises, ordered by
 * orderProducers (with this substrate's own peers when given). Rows are kept whole (origin, protocol, multiaddr), so the walk
 * routes a cached row exactly as it routes a discovery row.
 *
 * Failure mode this guards: the cache kept ONE endpoint per shape, last registry
 * row winning, and the walk returned it before consulting discovery — so a local
 * producer lost to an overlay row listed after it.
 */
export function buildShapeProducerCache<T extends ProducerRow & { shapes?: unknown }>(rows: readonly T[], ownPeers?: ReadonlySet<string>): Map<string, T[]> {
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
  for (const [s, list] of byShape) byShape.set(s, orderProducers(list, ownPeers));
  return byShape;
}

/**
 * The walk's pick over an ordered producer list. Rows without an endpoint are skipped, and so is a row discovery stamped
 * `egress_unreachable` (this node's federation egress is not live, discovery index.ts localEgressLiveness): a dead
 * candidate. A route whose ENDPOINT is loopback is probed (probe false or throwing = dead) and, when dead, the pick falls
 * through to the next row. That covers a local row AND a libp2p row: routeFor maps a libp2p row to this node's own
 * egress, a loopback dial exactly as probeable as a local row (REACHABILITY b; the rule "relay rows are accepted unprobed"
 * dates from 3df384a, 07-02, and assumed the relay hop could not be checked from here). A route to a non-loopback host
 * (a re-homed peer row, dialsOwnEndpoint) is accepted unprobed, as before. One probe per distinct endpoint per pick.
 * When every candidate was dead, the first one is returned: never below the status quo, so a local row whose only fault
 * was one missed probe never loses to an egress that also failed. `exclude` (route keys, `keyOf`) skips routes this walk
 * already saw fail for the shape (REACHABILITY c). Empty: null.
 */
export async function pickProducerRoute<T extends ProducerRow, R>(
  rows: readonly T[],
  routeFor: (row: T) => R,
  probe: (endpoint: string) => Promise<boolean>,
  opts: { endpointOf?: (route: R) => string | undefined; keyOf?: (route: R) => string; exclude?: ReadonlySet<string> } = {},
): Promise<R | null> {
  let first: R | null = null;
  const probed = new Map<string, boolean>();
  for (const row of rows) {
    if (typeof row?.endpoint !== "string" || !row.endpoint) continue;
    if ((row as { egress_unreachable?: unknown }).egress_unreachable === true) continue;
    const route = routeFor(row);
    if (opts.exclude && opts.keyOf && opts.exclude.has(opts.keyOf(route))) continue;
    // With the caller's endpointOf, the decision is the ROUTE's: a libp2p route dials this node's egress (loopback,
    // probed); a peer row routed through its gateway does not (unprobed). Without it, the row rule stands: only a local
    // loopback row is probed (a remote row's loopback endpoint names the PEER's loopback, not ours).
    const routeEp = opts.endpointOf ? opts.endpointOf(route) : undefined;
    const probeable = routeEp !== undefined ? isLoopbackEndpoint(routeEp) : (producerClass(row) === 0 && isLoopbackEndpoint(row.endpoint));
    const ep = routeEp ?? row.endpoint;
    if (!probeable) return route;
    if (first === null) first = route;
    let ok = probed.get(ep);
    if (ok === undefined) {
      try { ok = await probe(ep); } catch { ok = false; /* dead candidate — try the next producer of this shape */ }
      probed.set(ep, ok);
    }
    if (ok) return route;
  }
  return first;
}

/**
 * WHICH concept-db THE WALK RECALLS FROM. Same rule as the walk's producer pick (orderProducers, dialsOwnEndpoint):
 * a local row, then a row reached through this substrate's own nodes, then the federation relay (libp2p), and a
 * foreign peer's http row only when nothing else exists. Measured 2026-10-16: goal-host took the FIRST non-libp2p
 * concept-db row in discovery order; on the compose and spoke nodes that was a federation peer's concept-db re-homed
 * onto a port its firewall drops, so every lesson recall timed out (3,220 timeouts/24 h on one node, no success at all on
 * another since 10-10) while the sibling node's own concept-db answered in milliseconds.
 */
export function pickConceptDbRow<T extends ProducerRow & { id?: unknown; vesselId?: unknown; libp2p_multiaddr?: unknown }>(
  rows: readonly T[],
  ownPeers?: ReadonlySet<string>,
): { via: 'http' | 'relay'; row: T } | null {
  const named = rows.filter((x) => /concept-db/i.test(String(x?.id ?? x?.vesselId ?? '')));
  const isRelay = (x: T) => Array.isArray(x.libp2p_multiaddr) && typeof (x.libp2p_multiaddr as unknown[])[0] === 'string';
  const isHttp = (x: T) => x.protocol !== 'libp2p' && typeof x.endpoint === 'string' && x.endpoint.length > 0;
  const own = (x: T) => { const o = urlOrigin(x.peerEndpoint); return o !== null && !!ownPeers?.has(o); };
  const local = named.find((x) => isHttp(x) && producerClass(x) === 0);
  if (local) return { via: 'http', row: local };
  const ownPeer = named.find((x) => isHttp(x) && x.discoveredVia === 'peer' && own(x));
  if (ownPeer) return { via: 'http', row: ownPeer };
  const relay = named.find(isRelay);
  if (relay) return { via: 'relay', row: relay };
  const other = named.find(isHttp);
  return other ? { via: 'http', row: other } : null;
}

/**
 * A row THIS SUBSTRATE serves (CHANGE-29): a local row, or a peer row reached through one of this substrate's own nodes
 * (`ownPeers`, the substrateNodes discovery origins) that dials its own endpoint. A libp2p row, a row with no
 * endpoint, and a peer row reached through any other peer (a foreign substrate's) are not. With no `ownPeers`, only
 * local rows are.
 */
export function isOwnSubstrateRow(row: ProducerRow, ownPeers?: ReadonlySet<string>): boolean {
  if (!row || !row.endpoint || row.protocol === "libp2p") return false;
  if (producerClass(row) === 0) return true;
  const o = urlOrigin(row.peerEndpoint);
  return !!ownPeers && o !== null && ownPeers.has(o) && dialsOwnEndpoint(row);
}
