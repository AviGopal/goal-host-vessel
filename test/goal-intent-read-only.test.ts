import { describe, it, expect } from "bun:test";
import { isEditIntentGoal, goalDemandsLandedEdit } from "../src/goal-intent";

/**
 * CHECK-FIRST, CLASS NOT EXAMPLES: a request that forbids changing anything is never edit-intent.
 *
 * test/goal-target-needs.test.ts pins (ii) with three fixed phrasings ("Do not change anything.",
 * "don't edit or update any file", "Never add, remove or modify anything."). A regex on exactly
 * those three strings passes it and leaves the class open. The defect is structural: both
 * predicates in src/goal-intent.ts look for a mutation verb ANYWHERE in the goal, and in a
 * read-only request the verb sits INSIDE the clause that forbids mutation.
 *
 * So this file GENERATES the read-only class — read-only lead × negator × forbidden verb phrase ×
 * object × clause position, over vessel/file names that appear nowhere else — and asserts both
 * predicates over all of it. Verbs come from both predicates' lists (they differ: delete/rename
 * only route, implement/extend/apply only demand), plus gerunds (writing, creating, generating).
 *
 * CONTROLS stop the over-broad repair. A genuine edit can carry a negated or scoped qualifier
 * ("without changing its signature", "do not modify any other file", "Don't forget to update…",
 * "Do not just report on it: fix…") and must stay edit-intent AND demand a landed edit; a fix that
 * discards every goal containing a negator, or strips every negated clause including "don't
 * forget to", fails them. A sanity control proves each lead alone is not edit-intent, so the red
 * comes from the forbidding clause and nothing else.
 */

const LEADS: string[] = [
  "Read repos/orbit-vessel/src/scheduler.ts and summarise what it exports",
  "Explain how repos/kiln-vessel/src/firing.ts decides the kiln temperature",
  "List the functions declared in repos/atlas-vessel/src/routes/tiles.ts",
  "Tell me which shapes repos/harbor-vessel/src/berths.ts advertises",
];

const NEGATORS: string[] = ["Do not", "Don't", "Never", "Please do not", "You must not", "Do NOT"];

const FORBIDDEN_VERBS: string[] = [
  "change", "edit", "modify", "update", "delete", "rename", "refactor", "fix",
  "touch or change", "edit or update", "add, remove or modify", "write to",
  "create or write", "implement or extend anything in", "apply edits to",
];

const OBJECTS: string[] = ["anything", "any file", "the source", "a single line of it"];

const GERUND_CLAUSES: string[] = [
  "Answer without writing or creating any files",
  "Do this without generating, authoring or writing anything",
  "This is read-only: no writing, no creating, no scaffolding",
];

function generateReadOnly(): string[] {
  const out: string[] = [];
  for (const lead of LEADS) {
    for (const neg of NEGATORS) {
      for (const verb of FORBIDDEN_VERBS) {
        for (const obj of OBJECTS) {
          // "implement or extend anything in" already carries its object's quantifier.
          const clause = verb.endsWith(" in") ? `${neg} ${verb} ${obj === "anything" ? "the file" : obj}` : `${neg} ${verb} ${obj}`;
          out.push(`${lead}. ${clause}.`);
          out.push(`${clause}; just ${lead.charAt(0).toLowerCase()}${lead.slice(1)}.`);
        }
      }
    }
    for (const g of GERUND_CLAUSES) {
      out.push(`${lead}. ${g}.`);
      out.push(`${g}: ${lead.charAt(0).toLowerCase()}${lead.slice(1)}.`);
    }
  }
  return out;
}

const READ_ONLY_CLASS = generateReadOnly();

const GENUINE_EDITS: string[] = [
  "Fix the off-by-one in repos/orbit-vessel/src/scheduler.ts without changing its exported signature.",
  "Add a retry around the fetch in repos/kiln-vessel/src/firing.ts; do not modify any other file.",
  "Don't forget to update repos/atlas-vessel/src/routes/tiles.ts with the new tile size.",
  "Do not just report on it: fix the null check in repos/harbor-vessel/src/berths.ts.",
  "Refactor repos/orbit-vessel/src/scheduler.ts into smaller functions, but never change its behaviour.",
];

function offenders(goals: string[], pred: (g: string) => boolean, want: boolean): string[] {
  return goals.filter((g) => pred(g) !== want);
}

function summarise(bad: string[], of: number): string[] {
  return bad.length === 0 ? [] : [`${bad.length}/${of} wrong`, ...bad.slice(0, 8)];
}

describe("(ii) class: generated read-only requests are never edit-intent", () => {
  it("MUST-FAIL (ii-class): no generated read-only request is routed as edit-intent", () => {
    expect(summarise(offenders(READ_ONLY_CLASS, isEditIntentGoal, false), READ_ONLY_CLASS.length)).toEqual([]);
  });

  it("MUST-FAIL (ii-class): no generated read-only request demands a landed edit", () => {
    expect(summarise(offenders(READ_ONLY_CLASS, (g) => goalDemandsLandedEdit(g), false), READ_ONLY_CLASS.length)).toEqual([]);
  });

  it("CONTROL (ii-class): each read-only lead alone is neither edit-intent nor demands a landed edit", () => {
    const leads = LEADS.map((l) => `${l}.`);
    expect(offenders(leads, isEditIntentGoal, false)).toEqual([]);
    expect(offenders(leads, (g) => goalDemandsLandedEdit(g), false)).toEqual([]);
  });

  it("CONTROL (ii-class): a genuine edit carrying a negated or scoped qualifier stays edit-intent and demands a landed edit", () => {
    expect(offenders(GENUINE_EDITS, isEditIntentGoal, true)).toEqual([]);
    expect(offenders(GENUINE_EDITS, (g) => goalDemandsLandedEdit(g), true)).toEqual([]);
  });
});
