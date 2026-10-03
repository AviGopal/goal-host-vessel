// EXEC-PLACEHOLDER INTERPOLATION — threading produced pool-shape content into an executor command.
//
// KEYSTONE (content-threading -> function-composition, 2026-07-27): deterministically
// interpolate {{shape}} / {{shape.field}} placeholders in an executor command with the
// CONTENT of already-produced pool shapes (poolVars), shell-safe single-quoted. This makes
// the command that RUNS a FUNCTION of threaded input shapes (the LLM chooses only the
// operator/structure), so the resolver sequence is a genuine f(g(x)) variable-interpolation-
// through-functions: correctness reduces to selecting the right activity and causality is
// assignable to the threaded prerequisite shapes. Unknown placeholders are left intact.
//
// Extracted verbatim from index.ts so the splice can be exercised without starting the server.

const _shq = (v: string): string => "'" + v.replace(/'/g, "'\\''") + "'";
const _valForPlaceholder = (raw: unknown, field?: string): string | null => {
  let val: unknown = raw;
  if (field && val && typeof val === "object" && val !== null) val = (val as Record<string, unknown>)[field];
  if (val == null) return null;
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    for (const k of ["content", "stdout", "value", "text", "path", "body"]) if (typeof o[k] === "string") return o[k] as string;
    try { return JSON.stringify(val); } catch { return null; }
  }
  return String(val);
};
export const interpolateExecPlaceholders = (cmd: string, vars: Record<string, unknown>): string =>
  cmd.replace(/\{\{\s*([a-zA-Z0-9_:]+)(?:\.([a-zA-Z0-9_]+))?\s*\}\}/g, (m: string, sh: string, field?: string) => {
    if (!(sh in vars)) return m;
    const val = _valForPlaceholder(vars[sh], field);
    return val == null ? m : _shq(val);
  });
