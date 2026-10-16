/**
 * WHAT A SHAPE NAME IS (CHANGE-35). A shape is a routing key: an identifier, optionally namespaced with ':' or '.',
 * never prose. Nothing checked this where shape names enter goal-host, so a feed could hand the walk a "shape" like
 * "code_quality with substantive assessment content" (RUN 0, 2026-10-16) as a goal target. One rule, used wherever an
 * outside feed supplies shape names: the learned-deliverable vocabulary and a caller's expected_output_shapes.
 */
export const SHAPE_NAME_RE = /^[A-Za-z][A-Za-z0-9_:.\-]{0,127}$/;
export function isShapeName(s: unknown): s is string {
  return typeof s === "string" && SHAPE_NAME_RE.test(s);
}
