/**
 * The report body of a `/v2/impulses/resolve` answer, in EITHER wire format.
 *
 * A vessel reached DIRECTLY answers `{ success, shape, body }`. The SAME vessel
 * reached through the federation proxy answers `{ content: { shape, produced_by,
 * body, note }, metadata }` — with no top-level `body` at all. The naive unwrap
 * `j.body ?? j` therefore returns an object carrying no `verdict`, and a complete,
 * successful report is read as ABSENT.
 *
 * Observed 2026-08-10: `feature_compose` and `patch_with_tools` are both advertised
 * libp2p-only (`development-vessel-local@…`, endpoint 8401 = federation-transport),
 * so the edit-intent route ALWAYS received the proxied form. Every goal-dispatched
 * edit logged `verdict=(none) … no failure detail in compose report` while the
 * compose had in fact run and returned a real verdict — the work was discarded at
 * the unwrap. The gap-compose lane was unaffected because it calls the resolver
 * in-process, which is exactly why that lane landed commits all day while no
 * dispatched edit ever landed.
 *
 * Order matters: a direct `body` wins over a `content` sibling, so a vessel that
 * someday returns both is read the same way it is today.
 */
export function resolveReportBody(j: unknown): Record<string, unknown> {
  const isObj = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === "object" && !Array.isArray(x);
  if (!isObj(j)) return {};
  const content = isObj(j["content"]) ? j["content"] : undefined;
  const nested = content && isObj(content["body"]) ? content["body"] : undefined;
  // direct body -> proxied content.body -> content -> the response itself
  for (const cand of [j["body"], nested, content, j]) {
    if (isObj(cand)) return cand;
  }
  return {};
}
