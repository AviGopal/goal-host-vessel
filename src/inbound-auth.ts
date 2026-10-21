/**
 * WHO IS CALLING GOAL-HOST: THE INBOUND DOOR (operator security review, 2026-10-19).
 *
 * POST /run-goal and POST /resolve authenticated nobody. Anyone who reached the port started walks (an edit-intent
 * goal reaches feature_compose), injected impulses into a running walk that then counted as the walk's own production,
 * answered a pending solicitation, or started a judge replay; and a caller-supplied `operator` field made the dispatch
 * operator-originated, with the operator trace tag and the operator-goal-unserved gap filing that go with it.
 *
 * THE DOOR. Every dispatching or writing entry (POST /run-goal; /resolve for the types in GATED_RESOLVE_TYPES) needs
 * `Authorization: ApiKey <key>` that identity-vessel authenticates, through the fleet's existing validator
 * (caller-credential.ts, a byte-for-byte copy of development-vessel's: the node's own key is node-self, every other
 * key is asked of identity, fail closed). The check runs before anything else the request could change: no
 * spend-rate window, no dispatch record, no queue. Reads stay open (a separate decision, filed as its own gap).
 *
 * AUTHORITY COMES FROM THE CREDENTIAL, NEVER FROM THE BODY. A request's `operator` field is a label the caller
 * claims. It is kept as `operator_label`; the dispatch is operator-originated only when the validated credential
 * carries "operator:direct" ("admin" as the interim fallback), the predicate development-vessel's operator-direct.ts
 * already uses. The node's own key and in-process self-calls are never an operator.
 *
 * REFUSALS ARE VISIBLE. Every refusal logs the route, the shape, why, and a caller hint (remote address, user agent,
 * the template id the request names, the CLAIMED x-caller-vessel), and is counted by that hint in /health
 * (`inbound_auth`). The hint is unauthenticated text: it is bounded and stripped, it can add a lead, never an identity.
 * Nothing about the presented key is ever logged, counted or returned.
 *
 * FEDERATION. The transport's ingress forwards to this door with the transport's own key, so a federated request
 * authenticates as the transport (a service, never an operator). Who the remote caller was is decided at the ingress:
 * wherever federation is exposed, fedIngressAuthPolicy must be `enforce`, or anyone who can dial the overlay still
 * reaches this door as the transport.
 */
import { createHash } from "node:crypto";
import { identityCredential, isNodeSelfCredential, type CallerCredential } from "./caller-credential";

export const OPERATOR_DIRECT_SCOPE = "operator:direct";
export const ADMIN_SCOPE = "admin";

/** The /resolve types that dispatch or write. Every other type /resolve serves is a read and stays open. */
export const GATED_RESOLVE_TYPES: ReadonlySet<string> = new Set([
  "goal_execution", "activity_execution",
  "goalDispatchAsync", "goal_dispatch_async",
  "poolImpulse_write", "solicitationResponse_write", "solicitationHeartbeat_write",
  "verdictCorpusRun",
]);

/** Who a request runs as. `operator` is derived from the credential's scopes; nothing in a body can set it. */
export interface Principal {
  readonly kind: "node_self" | "key";
  readonly keyId?: string;
  readonly scopes: readonly string[];
  readonly operator: boolean;
  /** True for goal-host's own self-calls, which never leave the process. */
  readonly inProcess?: boolean;
}

/** goal-host calling itself in-process (requeue, resume, escalation, authoring): the node's own identity, never an operator. */
export const SELF_PRINCIPAL: Principal = Object.freeze({ kind: "node_self", scopes: Object.freeze(["node"]), operator: false, inProcess: true });

/** Whether an identity-validated credential carries operator authority: "operator:direct" or "admin", never node-self. */
export function isOperatorCredential(cred: CallerCredential): boolean {
  if (cred.authenticated !== true || isNodeSelfCredential(cred)) return false;
  const scopes = Array.isArray(cred.scopes) ? cred.scopes : [];
  return scopes.includes(OPERATOR_DIRECT_SCOPE) || scopes.includes(ADMIN_SCOPE);
}

export function principalOf(cred: CallerCredential): Principal {
  if (isNodeSelfCredential(cred)) return Object.freeze({ kind: "node_self", scopes: Object.freeze(["node"]), operator: false });
  return Object.freeze({ kind: "key", ...(cred.keyId ? { keyId: cred.keyId } : {}), scopes: Object.freeze([...(cred.scopes ?? [])]), operator: isOperatorCredential(cred) });
}

/** The name a principal is recorded under (an injected impulse's producedBy, a solicitation's answeredBy). Never the key. */
export function principalLabel(p: Principal): string {
  if (p.kind === "node_self") return p.inProcess ? "node-self:in-process" : "node-self";
  return p.keyId ? `key:${p.keyId}` : `key:scopes=${p.scopes.join("+") || "none"}`;
}

/** What a dispatch record keeps about its principal. */
export function principalRecord(p: Principal): { kind: Principal["kind"]; label: string; operator: boolean } {
  return { kind: p.kind, label: principalLabel(p), operator: p.operator };
}

/** The principal a READ shows: its kind, whether it carried operator authority, and a non-reversible tag of the key. */
export interface ServedPrincipal { kind: Principal["kind"]; operator: boolean; tag: string | null }

/**
 * A key's served tag: the first 12 hex of sha256 over its key id, so a reader can tell two dispatches by the same key
 * apart from two by different keys without the key id being published. Null for the node's own identity and for a
 * principal recorded without a key id.
 */
export function principalTag(label: string): string | null {
  if (!label.startsWith("key:") || label.startsWith("key:scopes=")) return null;
  return createHash("sha256").update(label.slice("key:".length)).digest("hex").slice(0, 12);
}

/**
 * What a READ of a dispatch record shows about who started it (goalWalkState, activeDispatches, GET /executions/:id):
 * the label the caller claimed and the principal it ran as. A reader attributes HANDS from these (a human operator
 * label marks a person's dispatch even when the credential gave it no authority); it is never authority. `operator`
 * stays the authority field, set only by operatorAuthority. These surfaces are open and federation-reachable, so the
 * principal is served by kind, authority and a non-reversible tag (principalTag), never by its recorded label, which
 * names the key id. Null when the record predates the door.
 */
export function dispatchAttribution(r: { operator_label?: string; principal?: { kind: Principal["kind"]; label: string; operator: boolean } }): {
  operator_label: string | null;
  principal: ServedPrincipal | null;
} {
  return {
    operator_label: r.operator_label ?? null,
    principal: r.principal ? { kind: r.principal.kind, operator: r.principal.operator, tag: principalTag(r.principal.label) } : null,
  };
}

/** The dispatch's operator: the caller's label, only when the credential carries operator authority. */
export function operatorAuthority(label: string | undefined, p: Principal): string | undefined {
  return p.operator ? label : undefined;
}

const hintSafe = (x: unknown, max: number): string => String(x ?? "").replace(/[^A-Za-z0-9_.:@\/+-]/g, "?").slice(0, max);

export interface CallerHintParts { remote?: string | null; userAgent?: string | null; callerVessel?: string | null; templateId?: unknown }

/** The bounded, stripped caller hint a refusal is logged and counted under. */
export function callerHint(h: CallerHintParts): string {
  const parts: string[] = [];
  if (h.templateId) parts.push(`template=${hintSafe(h.templateId, 80)}`);
  if (h.callerVessel) parts.push(`caller_vessel_claimed=${hintSafe(h.callerVessel, 48)}`);
  parts.push(`ua=${hintSafe(h.userAgent || "none", 48)}`);
  parts.push(`remote=${hintSafe(h.remote || "unknown", 48)}`);
  return parts.join(" ");
}

export const REFUSAL_COUNTER_MAX_CALLERS = 64;
let refusedTotal = 0;
const refusedByCaller = new Map<string, number>();

/** The /health `inbound_auth` key: refusals in total and by caller hint (bounded; overflow is counted as "other"). */
export function inboundAuthCounters(): { refused_total: number; by_caller: Record<string, number> } {
  return { refused_total: refusedTotal, by_caller: Object.fromEntries(refusedByCaller) };
}

/** Tests only. */
export function __resetInboundAuthForTests(): void {
  refusedTotal = 0;
  refusedByCaller.clear();
}

function countRefusal(hint: string): void {
  refusedTotal++;
  const key = refusedByCaller.has(hint) || refusedByCaller.size < REFUSAL_COUNTER_MAX_CALLERS ? hint : "other";
  refusedByCaller.set(key, (refusedByCaller.get(key) ?? 0) + 1);
}

export type InboundAuthResult = { ok: true; principal: Principal } | { ok: false; response: Response };

/**
 * Authenticate one inbound dispatching or writing request. `headers` are the request's; `validate` is the fleet
 * validator (a seam for tests). A refusal is answered 401 with the code the fleet's auth-refusal readers recognise.
 */
export async function authenticateInbound(
  headers: Headers,
  ctx: { route: string; shape: string; remote?: string | null; templateId?: unknown },
  validate: typeof identityCredential = identityCredential,
): Promise<InboundAuthResult> {
  const cred = await validate(headers.get("authorization") ?? undefined, { xApiKeyPresented: headers.get("x-api-key") !== null });
  if (cred.authenticated) return { ok: true, principal: principalOf(cred) };
  const why = cred.why ?? "not authenticated";
  const hint = callerHint({ remote: ctx.remote, userAgent: headers.get("user-agent"), callerVessel: headers.get("x-caller-vessel"), templateId: ctx.templateId });
  countRefusal(hint);
  console.warn(`[goal-host-vessel] inbound-auth REFUSED route=${ctx.route} shape=${hintSafe(ctx.shape, 48)} why=${why} ${hint}`);
  return {
    ok: false,
    response: Response.json({ error: `caller_credential_required: ${hintSafe(ctx.shape, 48)} needs a credential identity validates; ${why}`, code: "caller_credential_required" }, { status: 401 }),
  };
}
