/**
 * J1: A TOOL CALL IS ATTRIBUTED TO ITS DISPATCH WITHOUT OVERWRITING THE CALL'S OWN ARGUMENTS (design J1-J4.md).
 *
 * Measured: the floor's ufExecuteTool stamped {execution_id: dispatchId} as an EXTRA, which toolPointer applies OVER the
 * model's args, and the discovery proxy stamped execution_id whenever a pointer had none. But execution_id is also an
 * INPUT: development-vessel's execution_trace resolver reads it as the trace to fetch (its subject). So a floor call
 * `execution_trace {execution_id: E}` reached the resolver with the dispatch's id instead of E, and a call naming no
 * execution_id was handed the dispatch's own, reading the wrong trace either way.
 *
 * The rule: attribution travels under dispatch_id, always. execution_id is filled from the dispatch only when the call
 * names none AND the target's resolver_schema does not declare execution_id as one of its inputs (read from the schema,
 * not a list of shape names); a call's own execution_id is never replaced.
 */
export function attributionFields(
  pointer: Readonly<Record<string, unknown>>,
  dispatchId: string | undefined,
  schemaFieldNames: ReadonlySet<string> | null,
): Record<string, string> {
  if (!dispatchId) return {};
  const out: Record<string, string> = {};
  if (pointer["dispatch_id"] === undefined) out["dispatch_id"] = dispatchId;
  const hasOwn = typeof pointer["execution_id"] === "string" && (pointer["execution_id"] as string).length > 0;
  if (!hasOwn && !schemaFieldNames?.has("execution_id")) out["execution_id"] = dispatchId;
  return out;
}
