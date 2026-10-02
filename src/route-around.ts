/**
 * THE ROUTE-AROUND RECORD (REALIGNMENT §2.0b; agentic-floor D P5; agentic-runner track 4 §5.2).
 *
 * MEASURED: when the walk stalled it logged one prose line ("no pick — missing shapes [X] have no
 * producer or constructible payload") and its structured facts — what was missing, which producers
 * were tried and why each failed, what the dispatch did next — died as local state. A refused
 * `web_search` payload and an absent producer read the same ("no producer"), the floor ran after it
 * with no record of why, and capability demand was counted per invented shape name (850 rows over 850
 * names). There was no route-around emitter at all.
 *
 * This is the EMITTER, at the stall site where `missingTargets` is still local state: one structured
 * record per stall (or re-frame trigger), carried on the walk result and mirrored onto the dispatch
 * record so goalWalkState serves it. The record names what the dispatch did next (`route_taken`),
 * set by whichever caller acts on the stall. It writes nothing new and opens no address.
 *
 * Deliberately NOT here: the need signature (open, output-shapes §7.2(ii)) — the record keys on the
 * goal hash and the missing set; the counter, threshold and encapsulation goal are the (b) generator.
 */

export type RouteTaken = "stop" | "reframe" | "retry:satisfier-suppressed" | "retry:feedback" | "universal-tool-fallback";

export interface FailedProducer { shape: string; producer: string; reason: string }

export interface RouteAroundRecord {
  kind: "stall" | "no_target" | "floor_as_pathway";
  at: number;
  goal_hash: string;
  target: string[];
  produced: string[];
  missing_producer: string[];
  failed_producers: FailedProducer[];
  termination: string;
  /** The latest route the dispatch took from this stall; `routes_taken` keeps the sequence. */
  route_taken: RouteTaken;
  routes_taken: RouteTaken[];
}

export const ROUTE_AROUND_FAILED_CAP = 24;

const REDACTED = "[redacted]";
/**
 * Upstream error bodies go onto goalWalkState, an unauthenticated read (§9.0), so they are scrubbed
 * of credential material first. Same rules as identity-vessel's redactCredential (exact secrets
 * held by this process, `mb-` API keys, compact JWTs), plus `Authorization`/`ApiKey`/`Bearer` values
 * and `*_KEY|SECRET|TOKEN|PASSWORD=value` env assignments echoed by a shell. Goal-host has no such
 * helper of its own to reuse; this one is the candidate to fold into a shared package.
 */
export function scrubReason(text: string, secrets: ReadonlyArray<string | undefined | null> = []): string {
  let out = String(text);
  for (const raw of secrets) {
    if (!raw) continue;
    const bare = raw.replace(/^(ApiKey|Bearer)\s+/i, "").trim();
    for (const needle of new Set([raw, bare])) if (needle.length >= 8) out = out.split(needle).join(REDACTED);
  }
  return out
    .replace(/\b(authorization|x-api-key)(["']?\s*[:=]\s*["']?)(?:(?:ApiKey|Bearer)\s+)?[^\s"',}]+/gi, `$1$2${REDACTED}`)
    .replace(/\b(ApiKey|Bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/g, `$1 ${REDACTED}`)
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS))=("[^"]*"|'[^']*'|\S+)/g, `$1=${REDACTED}`)
    .replace(/mb-[A-Za-z0-9_\-=]{8,}/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED);
}

export function buildRouteAround(a: {
  goalHash: string;
  target: Iterable<string>;
  produced: Iterable<string>;
  missing: string[];
  satisfierFailures: ReadonlyMap<string, string>;
  /** Template picks that failed to run this walk (unfetchable, threw), with the reason. */
  pickFailures: ReadonlyMap<string, string>;
  /** Credentials this process holds, scrubbed by exact match (scrubReason). */
  secrets?: ReadonlyArray<string | undefined | null>;
  termination: string;
  kind?: RouteAroundRecord["kind"];
  now?: number;
}): RouteAroundRecord {
  const failed: FailedProducer[] = [];
  const clean = (r: string) => scrubReason(String(r), a.secrets ?? []).slice(0, 240);
  for (const [shape, reason] of a.satisfierFailures) failed.push({ shape, producer: `satisfier:${shape}`, reason: clean(reason) });
  for (const [producer, reason] of a.pickFailures) failed.push({ shape: "", producer, reason: clean(reason) });
  return {
    kind: a.kind ?? (a.missing.length > 0 ? "stall" : "no_target"),
    at: a.now ?? Date.now(),
    goal_hash: a.goalHash,
    target: [...a.target],
    produced: [...a.produced].filter((s) => s !== "goal"),
    missing_producer: [...a.missing],
    failed_producers: failed.slice(0, ROUTE_AROUND_FAILED_CAP),
    termination: scrubReason(a.termination, a.secrets ?? []).slice(0, 300),
    route_taken: "stop",
    routes_taken: [],
  };
}

/** The caller that acts on a stalled walk names its route on that walk's record (same object the
 *  dispatch record holds). A walk that did not stall has no record and nothing is written. */
export function noteRouteTaken(rec: RouteAroundRecord | undefined, route: RouteTaken): void {
  if (!rec) return;
  rec.route_taken = route;
  rec.routes_taken.push(route);
}
