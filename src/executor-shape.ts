// EXECUTOR SHAPE — ONE answer to "does this shape's resolver RUN a command the walk synthesises?"
//
// Three walk sites asked it with their own copy of the same regex: the payload builder (which names
// the executable field the LLM must synthesise), the satisfier's self-correction gate, and the
// compute-deferral ordering. All three carried `(^|[_-])exec`, which matches the "exec" that BEGINS
// "execution…". Measured: one resolve of executionTraceWithSignatures — a heavy trace read — was
// classified as an executor, given a synthesised shell command (`arp -a`, an nmap scan) as its
// `command` arg, judged degenerate on every reply, and re-issued through the whole correction budget
// plus a post-loop arg-correction: eight heavy reads for one shape, each abandoned by the client while
// the server kept running it.
//
// The exec token is therefore a whole word segment: `exec` followed by a separator, the end, or
// `result` (exec_result, aws-exec-read, execResult). Every other alternative is unchanged.

/** The executor-shape vocabulary. The exec token is anchored on both sides; the rest is as it was. */
export const EXECUTOR_SHAPE_PATTERN =
  /(^shellResult$|shell|bash|(^|[_-])exec([_-]|$|result)|(^|[_-])command|(^|[_-])(sql|script|cmd)([_-]|$|result|query))/i;

/** Whether the shape's resolver runs a synthesised command (shell / exec / command / sql / script). */
export function isExecutorShape(shape: string): boolean {
  return EXECUTOR_SHAPE_PATTERN.test(shape);
}

/**
 * Whether a resolve went UNANSWERED: no value came back AND no response arrived at all — the request
 * failed at the transport (the client timed out, the connection was refused), so there is no HTTP
 * status and rawResolve recorded a `transport:` reason. Nothing then says the request was wrong, and
 * the server may still be running it, so it is not corrected: a re-synthesised command or corrected
 * args would only stack a second request on the first.
 *
 * A 5xx is NOT unanswered. The producer ran and answered, and a resolver host reports a resolver's
 * own throw — "invalid URL", "pattern is required" — as HTTP 500, so the error-informed correction is
 * exactly the repair for it. That is why this is narrower than transient-failure.ts, which counts any
 * 5xx as transient for the purpose of a verbatim retry.
 */
export function unanswered(resolved: unknown, status: number | undefined, reason: string | null | undefined): boolean {
  return resolved == null && status === undefined && typeof reason === "string" && /^transport: /.test(reason);
}
