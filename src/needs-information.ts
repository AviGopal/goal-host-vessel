/**
 * J2a: THE WALK CAN ASK, LAST (design J1-J4.md §J2, as approved with qa's conditions 2026-10-17).
 *
 * A dispatch whose resolver refused for a REQUIRED input, where every derivation the walk has for that input was tried
 * and bound nothing, ends with a structural outcome `needs_information` naming what is missing and what was tried,
 * instead of a hollow or confabulated answer. It is the LAST resort, never an easy exit (law 13: a human is not a
 * preprocessor; the user, 10-16: what the environment holds, the system derives):
 *   - a field counts as MISSING only when the resolver named it as required AND both derivations ran for it and bound
 *     nothing: the pool bind (an existing impulse carrying the field) and the tool investigation (the walk's grounded
 *     read/search over the environment, a.5). A field either one supplies is derived, never asked for;
 *   - a later attempt that the resolver ACCEPTS clears that shape's record (a refusal that was then repaired is not a
 *     missing input);
 *   - a dispatch that REACHED carries no such outcome.
 * Structural only: the field names come from the resolver's own refusal (requiredFieldsFromCorrection), never from the
 * goal's wording. GRADING (pre-stated): needs_information is NOT reached; it is its own outcome class, and the reach
 * judge's exemption only stops it being graded as a wrong answer.
 */
import type { NovelTarget } from "./novel-target";

export type Derivation = "pool_bind" | "investigation";
const ALL_DERIVATIONS: readonly Derivation[] = ["pool_bind", "investigation"];

export interface MissingInput { shape: string; field: string; tried: Derivation[] }
/** unbound_input: a required input no derivation found (J2a). novel_target: no existing shape's production satisfies
 *  the goal, with the chooser's described residual (J2b, novel-target.ts). */
export interface NeedsInformationOutcome { kind: "needs_information"; reason: "unbound_input" | "novel_target"; missing: MissingInput[]; residual?: NovelTarget }

/** Per-dispatch record of required inputs the walk could not derive. */
export class UnboundInputs {
  private readonly byShape = new Map<string, Map<string, Set<Derivation>>>();
  /** J2b: the target chooser's NOVEL answer for this dispatch (no candidate produces what the goal needs). */
  novel: NovelTarget | null = null;

  noteNovel(n: NovelTarget): void { this.novel = n; }

  /** The resolver for `shape` refused for `fields`; `derivation` ran for each and bound nothing. */
  noteUnderived(shape: string, fields: readonly string[], derivation: Derivation): void {
    if (fields.length === 0) return;
    const m = this.byShape.get(shape) ?? new Map<string, Set<Derivation>>();
    for (const f of fields) (m.get(f) ?? m.set(f, new Set()).get(f)!).add(derivation);
    this.byShape.set(shape, m);
  }

  /** A derivation supplied `field` for `shape`: it is not missing. */
  noteDerived(shape: string, field: string): void {
    this.byShape.get(shape)?.delete(field);
  }

  /** The resolver for `shape` accepted a later attempt: nothing for it is missing. */
  noteAccepted(shape: string): void {
    this.byShape.delete(shape);
  }

  /** The inputs every derivation was tried for and none bound. */
  missing(): MissingInput[] {
    const out: MissingInput[] = [];
    for (const [shape, m] of this.byShape) for (const [field, tried] of m) {
      if (ALL_DERIVATIONS.every((d) => tried.has(d))) out.push({ shape, field, tried: ALL_DERIVATIONS.filter((d) => tried.has(d)) });
    }
    return out;
  }
}

/** The dispatch's terminal outcome, if it is a needs-information one. */
export function needsInformationOutcome(rec: UnboundInputs | undefined, reached: boolean): NeedsInformationOutcome | undefined {
  if (reached || !rec) return undefined;
  const missing = rec.missing();
  if (missing.length > 0) return { kind: "needs_information", reason: "unbound_input", missing };
  return rec.novel ? { kind: "needs_information", reason: "novel_target", missing: [], residual: rec.novel } : undefined;
}

/** The question a present human is shown: built from the missing field names and what was tried, not the goal's wording. */
export function questionFor(outcome: NeedsInformationOutcome): string {
  if (outcome.reason === "novel_target" && outcome.residual) {
    const c = outcome.residual.closest;
    return `No existing capability produces what this goal needs: ${outcome.residual.residual}${c ? `\n(nearest: \`${c.shape}\`, which does not satisfy it because ${c.why_not})` : ""}`;
  }
  const lines = outcome.missing.map((m) => `- \`${m.field}\` (needed by \`${m.shape}\`; tried: ${m.tried.join(", ")}; nothing found)`);
  return `The walk needs a value it could not derive from the environment:\n${lines.join("\n")}`;
}
