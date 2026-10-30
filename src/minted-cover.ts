// A MINTED TEMPLATE THAT COVERS THE GOAL IS PROBED BEFORE THE SATISFIER SHORTCUT.
//
// Gap a-minted-template-is-never-selected-for-a-paraphrased-goal-because-pathway-reuse-keys-on-the-exact-goal-hash-or-
// count-gated-shape-cover-and-satisfiers-always-win. A goal the system has done before, worded differently, never ran
// the template the ribosome extracted from the first run: pathway reuse keys on the exact goal hash (or on count-gated
// shape cover), and the satisfier resolves a single served target in one step before any template is picked. The
// composition-preference probe stopped the satisfier only for a producer covering >=2 missing targets and declined
// whenever an intermediate was directly producible. The walk now probes, ahead of the satisfier, for a ribosome-extracted
// (learned-*) candidate from the same recommend answer whose outputs cover EVERY missing target, executable now, and
// slot-level by the instance-value lint (template-instance-lint.ts): a template still carrying its source run's record is
// refused, so the probe can never replay instance values. An unreadable template is refused (fail closed). No new
// matcher: the candidates are recommend's, read by the walk's own candidate reader.

import { lintTemplateInstanceValues, type InstanceLintFinding } from "./template-instance-lint";

export type CoverCandidate = { id: string; inputShapes: string[]; outputShapes: string[] };
export type MintedCoverVerdict = { pick: string | null; refused: Array<{ id: string; why: string }> };

const bare = (id: string) => id.replace(/^activity:/, "").replace(/[⟨⟩]/g, "").trim();

/** The first ribosome-extracted candidate covering every missing target, executable now and slot-level. */
export async function mintedCover(
  candidates: ReadonlyArray<CoverCandidate | null>,
  missing: readonly string[],
  produced: ReadonlySet<string>,
  excluded: (bareId: string) => boolean,
  getTemplate: (bareId: string) => Promise<unknown | null>,
): Promise<MintedCoverVerdict> {
  const refused: MintedCoverVerdict["refused"] = [];
  if (missing.length === 0) return { pick: null, refused };
  for (const c of candidates) {
    if (!c) continue;
    const id = bare(c.id);
    if (!id.startsWith("learned-") || excluded(id)) continue;
    if (!missing.every((sh) => c.outputShapes.includes(sh))) continue;
    if (!(c.inputShapes.length === 0 || c.inputShapes.every((sh) => produced.has(sh)))) continue;
    const tpl = await getTemplate(id).catch(() => null);
    const lint: InstanceLintFinding[] | null = tpl ? lintTemplateInstanceValues(tpl) : null;
    if (!lint) { refused.push({ id, why: "template unreadable" }); continue; }
    if (lint.length > 0) { refused.push({ id, why: `carries instance values (${lint.slice(0, 3).map((f) => `${f.kind}@${f.path}`).join("; ")})` }); continue; }
    return { pick: id, refused };
  }
  return { pick: null, refused };
}
