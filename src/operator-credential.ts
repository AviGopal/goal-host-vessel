/**
 * THE OPERATOR'S OWN CREDENTIAL, CARRIED TO THE ONE PLACE THAT CAN CHECK IT.
 *
 * `directed` used to be self-declared end to end: /run-goal set operatorOrigin for any request with an
 * `operator` field (autonomous dispatchers send one), the feature_compose call carried directed:true, and
 * development-vessel's registerAttempt stamped the intent directed, which exempts the landing from the
 * autonomy scope's excluded paths. goal-host cannot tell an operator from the walk: /run-goal is not
 * authenticated here, and every call goal-host makes carries its own fleet key.
 *
 * So goal-host decides nothing. When an operator-origin dispatch arrived with `Authorization: ApiKey <key>`,
 * that header is carried, unchanged, as `X-Operator-Authorization` on the feature_compose call, and
 * development-vessel asks identity-vessel what the key's scopes are (src/lib/operator-direct.ts there).
 * Only a key issued with "operator:direct" (or "admin", interim) makes the intent directed; anything else,
 * including no header, registers autonomous. A header goal-host invents can only be a key it holds, and
 * goal-host's fleet key has neither scope.
 *
 * Bounds on where the operator's key goes:
 *   - only on an operator-origin dispatch's feature_compose call;
 *   - only to a LOOPBACK compose endpoint (127.0.0.0/8, ::1, localhost). A discovery-resolved peer node's
 *     endpoint never receives it; such a compose is then autonomous (fail closed);
 *   - held in the dispatch's in-memory options only: never persisted with the dispatch record, never logged,
 *     never in a pointer or body. A resumed or requeued dispatch no longer has it and runs autonomous.
 */

/** The header development-vessel reads for the operator's credential on a feature_compose call. */
export const OPERATOR_AUTHORIZATION_HEADER = "X-Operator-Authorization";

/** The inbound Authorization header, when it is an ApiKey credential (the only scheme identity validates for this). */
export function operatorCredentialFromRequest(authorization: string | null | undefined): string | undefined {
  const h = String(authorization ?? "").trim();
  return /^ApiKey\s+\S+$/i.test(h) ? h : undefined;
}

/** Whether `url` names a loopback host. Unparseable is not loopback. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { return false; }
  if (host === "localhost" || host === "::1") return true;
  const v4 = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** The extra header for a feature_compose call to `composeUrl`: the operator's credential, or nothing. */
export function operatorCredentialHeaders(opts: { operatorOrigin?: boolean; operatorCredential?: string }, composeUrl: string): Record<string, string> {
  if (opts.operatorOrigin !== true) return {};
  const cred = operatorCredentialFromRequest(opts.operatorCredential);
  if (!cred || !isLoopbackUrl(composeUrl)) return {};
  return { [OPERATOR_AUTHORIZATION_HEADER]: cred };
}
