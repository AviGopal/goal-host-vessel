// NO LEARNED TEMPLATE THAT STILL CARRIES ITS SOURCE RUN IS SELECTED, ON ANY PICK PATH.
//
// Gap minted-templates-replay-instance-values-because-reach-to-mint-bakes-the-original-goals-record-ids-and-nouns-into-
// their-tasks. Until ribosome-extract stops writing them (the producer fix, executor lane), minted templates can carry
// the run they were extracted from (template-instance-lint.ts). Measured: a new remember goal ran the R2-minted
// learned-composition-memorynote-write as one sibling of the HORIZONTAL bundle; the lint had no caller on that path. The
// walk's shared candidate list (after the template_pick write door) and the bundle's forward fetch now drop a learned-*
// candidate the lint flags, so the single pick, reuse-before-derive and the bundle all choose from lint-clean templates.
// A non-learned template is never fetched or touched. An unreadable learned template is DROPPED (fail closed, qa ruling:
// harm first), tapped distinctly "DROPPED unchecked: template unreadable": a template that cannot be shown clean is not
// replayed while the producer fix is outstanding.

import { lintTemplateInstanceValues } from "./template-instance-lint";

export const LINT_VERDICT_TTL_MS = 5 * 60_000;
export const LINT_VERDICT_CACHE_CAP = 512;

const bare = (id: string) => id.replace(/^activity:/, "").replace(/[⟨⟩]/g, "").trim();
export const isLearnedTemplateId = (id: string) => bare(id).startsWith("learned-");

type Verdict = { at: number; why: string | null };
/** Per-process lint verdicts by template id (bounded, short-lived: a refined template is re-checked). */
export class LintVerdictCache {
  private m = new Map<string, Verdict>();
  constructor(private ttlMs = LINT_VERDICT_TTL_MS, private cap = LINT_VERDICT_CACHE_CAP) {}
  get(id: string, now: number): Verdict | undefined { const v = this.m.get(id); return v && now - v.at < this.ttlMs ? v : undefined; }
  set(id: string, v: Verdict): void { this.m.delete(id); this.m.set(id, v); while (this.m.size > this.cap) { const k = this.m.keys().next().value; if (k === undefined) break; this.m.delete(k); } }
}

export interface GuardResult<T> { kept: T[]; dropped: Array<{ id: string; why: string }>; unchecked: string[] }

/** The candidates with every lint-flagged learned-* template removed. */
export async function dropInstanceValueTemplates<T extends { id: string }>(cands: readonly T[], getTemplate: (bareId: string) => Promise<unknown | null>, cache: LintVerdictCache, now: number = Date.now()): Promise<GuardResult<T>> {
  const kept: T[] = []; const dropped: GuardResult<T>["dropped"] = []; const unchecked: string[] = [];
  for (const c of cands) {
    if (!isLearnedTemplateId(c.id)) { kept.push(c); continue; }
    const id = bare(c.id);
    let v = cache.get(id, now);
    if (!v) {
      const tpl = await getTemplate(id).catch(() => null);
      if (!tpl) { unchecked.push(id); continue; } // fail closed: not cached, so the next read retries
      const f = lintTemplateInstanceValues(tpl);
      v = { at: now, why: f.length > 0 ? f.slice(0, 3).map((x) => `${x.kind}@${x.path}`).join("; ") : null };
      cache.set(id, v);
    }
    if (v.why) dropped.push({ id, why: v.why }); else kept.push(c);
  }
  return { kept, dropped, unchecked };
}
