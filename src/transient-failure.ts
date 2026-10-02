// transient-failure — ONE answer to "was that failure transient?" for every retry site.
//
// A transient failure says the producer could not be ASKED this time (a dropped
// connection, a timeout, a restarting vessel answering 5xx, a rate limit, a lane at
// capacity). It says nothing about whether the producer can answer, so a single bounded
// retry is the honest response. A non-transient failure (a 4xx naming a bad request, a
// resolver rejecting its arguments) is information about the REQUEST and must not be
// retried verbatim.
//
// Before this module the walk's last-chance un-poison and the edit-intent compose retry
// each carried their own regex, and neither recognised an HTTP 5xx: a single 503 from the
// shell resolver ended a deterministic registry-count walk at 0 steps, and with the floor
// no longer offering a shell (floor-tools.ts) nothing routed around it.

/** Failure text that names a condition of the moment, not of the request. */
export const TRANSIENT_FAILURE_PATTERN =
  /external-evidence failure|cascading|no vessel advertising|rate.?limit|429|402|insufficient|exhaust|transport|timeout|timed out|empty content|fetch (threw|failed)|ECONNREFUSED|ECONNRESET|socket|BUSY|\bHTTP 5\d\d\b|unavailable/i;

/** An HTTP status that describes the server's moment (5xx, 429), not the request. */
export function isTransientHttpStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/** Whether a failure is transient: by status when one is known, else by its text. */
export function isTransientFailure(reason: string | null | undefined, status?: number): boolean {
  if (typeof status === "number" && Number.isFinite(status) && isTransientHttpStatus(status)) return true;
  return typeof reason === "string" && TRANSIENT_FAILURE_PATTERN.test(reason);
}
