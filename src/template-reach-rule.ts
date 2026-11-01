/**
 * A TEMPLATE WHOSE PRODUCT CARRIES ITS OWN VERDICT IS GRADED BY THAT VERDICT, NOT BY THE LLM JUDGE.
 *
 * development-vessel:own-check-baseline runs one classify task and pools an ownCheckBaseline impulse whose `verdict`
 * is one of a closed set (development-vessel src/resolvers/own-check-baseline.ts OwnCheckBaselineVerdict). The LLM
 * reach judge read that measurement as "does not provide a measurement" and graded the run HOLLOW, β-penalising a
 * template that did exactly what it is for. Its reach is decidable from its product alone:
 *   reached iff the run produced an ownCheckBaseline impulse whose verdict is in the closed set.
 * No impulse, or a verdict outside the set, is NOT reached (deterministic), never an abstain.
 *
 * The rules are keyed by the template id that ran, read at use time by the engine-path reach gate
 * (index.ts runGoalWithRecovery), which skips the judge when one applies. The verdict is the gate's ordinary
 * deterministic verdict (deterministic:true, reason `deterministic:<class>`), so it takes the same label, β and α paths
 * as every other oracle's. A template could later declare its own entry; until then this table is the only source.
 */

export interface TemplateReachRule {
  /** The rule's name, logged with every verdict it decides. */
  rule: string;
  /** The produced shape that carries the verdict (compared without a "<vessel>:" prefix). */
  shape: string;
  /** The field of that shape's body that holds the verdict. */
  field: string;
  /** The values of `field` that are a reach. */
  reached: readonly string[];
}

export const TEMPLATE_REACH_RULES: Readonly<Record<string, TemplateReachRule>> = {
  "development-vessel:own-check-baseline": {
    rule: "own_check_baseline_verdict",
    shape: "ownCheckBaseline",
    field: "verdict",
    reached: ["green_at_parent", "red_code_reachable", "red_environmental", "unrunnable"],
  },
};

export interface TemplateReachVerdict {
  reached: boolean;
  reason: string;
  deterministic: true;
  completion_shapes: string[];
  rule: string;
  /** The verdict value read off the product ("none" when no product carried one). */
  value: string;
}

const bare = (s: string): string => s.slice(s.lastIndexOf(":") + 1).toLowerCase();

/** The field's value on one impulse's content: the body itself, a `{shape, body}` envelope, or a `{content}` wrapper. */
function fieldOf(content: unknown, field: string): unknown {
  let c = content;
  if (typeof c === "string") { try { c = JSON.parse(c); } catch { return undefined; } }
  for (let i = 0; i < 3 && c && typeof c === "object" && !Array.isArray(c); i++) {
    const o = c as Record<string, unknown>;
    if (o[field] !== undefined) return o[field];
    c = o["body"] && typeof o["body"] === "object" ? o["body"] : o["content"];
  }
  return undefined;
}

/**
 * The verdict for a run of `templateId` whose produced impulses are `produced`, or null when no rule is keyed by that
 * template (the caller grades it as before). The last impulse of the rule's shape decides.
 */
export function templateReachVerdict(templateId: string | undefined | null, produced: ReadonlyArray<{ shape?: string; content?: unknown }> | undefined): TemplateReachVerdict | null {
  const r = templateId ? TEMPLATE_REACH_RULES[templateId] : undefined;
  if (!r) return null;
  const mine = (produced ?? []).filter((p) => typeof p.shape === "string" && bare(p.shape) === bare(r.shape));
  const raw = mine.length > 0 ? fieldOf(mine[mine.length - 1]!.content, r.field) : undefined;
  const value = typeof raw === "string" ? raw : raw === undefined ? "none" : JSON.stringify(raw).slice(0, 80);
  const reached = typeof raw === "string" && r.reached.includes(raw);
  const why = mine.length === 0
    ? `the run produced no ${r.shape} impulse`
    : reached
      ? `the run's ${r.shape} carries ${r.field}=${value}, one of [${r.reached.join(", ")}]`
      : `the run's ${r.shape} carries ${r.field}=${value}, not one of [${r.reached.join(", ")}]`;
  return {
    reached,
    deterministic: true,
    completion_shapes: reached ? [r.shape] : [],
    rule: r.rule,
    value,
    reason: `deterministic:template-reach-rule — rule=${r.rule} for ${templateId}: ${why}`,
  };
}
