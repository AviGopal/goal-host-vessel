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
 * Whether an executor resolve went UNANSWERED for a transient reason (timeout, transport, 5xx — the
 * shared transient-failure.ts classification): no reply came back, so nothing says the command was
 * wrong. Such a failure is retried where the walk retries, never corrected — a re-synthesised command
 * is a second request against a producer that may still be running the first.
 */
export function unansweredTransiently(resolved: unknown, transient: boolean): boolean {
  return resolved == null && transient;
}
