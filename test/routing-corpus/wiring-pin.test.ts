// PROTECTED: production routes through the entries the routing corpus pins (DESIGN §6.3). A corpus-green rule that
// production does not call is a hollow gate, so this reads src/index.ts as text and asserts, by anchor (never by line):
//   - the /run-goal door calls the core's resolveDoorGoal (not resolvePathlessCodeChangeGoal directly);
//   - the early edit-intent hand-off asks the core's handoffRoute and branches on its route and target;
//   - gap-record hydration composes the hand-off goal with the core's goalForRoutingOf;
//   - the moved expressions (the inline hand-off predicate and the inline hydration text) are gone from index.ts.
// Every anchor must be FOUND: a missing anchor is red, never vacuous. Each assertion is shown red on a mutant.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX = readFileSync(join(import.meta.dir, "..", "..", "src", "index.ts"), "utf8");

const MUST_CALL = [
  'import { resolveDoorGoal, handoffRoute as routingHandoff, goalForRoutingOf } from "./routing-core/entries";',
  ": await resolveDoorGoal(rawGoal, _routeRec.search(searchWorkspaceForTerm), _routeRec.tap((m) =>",
  "const earlyHandoff = routingHandoff({ goal_for_routing: goalForRouting, route_enabled: earlyEditIntentEnabled });",
  'if (earlyHandoff.route === "feature_compose" && earlyHandoff.target) {',
  "const earlyEditFile = earlyHandoff.target;",
  "if (hydFile) goalForRouting = goalForRoutingOf(goal, { cited_file: hydFile, summary: String(hydGap.summary ?? \"\") });",
];
/** The moved expressions. Each was in index.ts before the split; none may come back as a local copy. */
const MUST_NOT_CONTAIN = [
  "resolvePathlessCodeChangeGoal(",
  "const earlyEditVerb =",
  "const earlyFileOnlyMatch =",
  "const earlyReadOnlyVerb =",
  "const earlyInterrogative =",
  "(gap cites file: ${hydFile}",
  "goalForRouting.match(/repos\\/([\\w.-]+)\\/",
];

export function wiringOffences(text: string): string[] {
  const bad: string[] = [];
  for (const a of MUST_CALL) if (!text.includes(a)) bad.push(`anchor not found: ${a}`);
  for (const a of MUST_NOT_CONTAIN) if (text.includes(a)) bad.push(`moved expression back in index.ts: ${a}`);
  // ORDER: the hand-off is asked before the branch that uses its answer, and the door before the dispatch uses `goal`.
  const ask = text.indexOf(MUST_CALL[2]!);
  const branch = text.indexOf(MUST_CALL[3]!);
  if (ask < 0 || branch < 0 || branch < ask || branch - ask > 400) bad.push("the hand-off branch does not immediately follow routingHandoff");
  return bad;
}

describe("wiring pin: index.ts routes through the routing core", () => {
  test("every anchor found, no moved expression left", () => { expect(wiringOffences(INDEX)).toEqual([]); });
  test("MUTANT the door calling the resolver directly is red", () => {
    expect(wiringOffences(INDEX.replace(": await resolveDoorGoal(rawGoal,", ": await resolvePathlessCodeChangeGoal(rawGoal,")).length).toBeGreaterThan(0);
  });
  test("MUTANT a local copy of the hand-off predicate is red", () => {
    const m = INDEX.replace(MUST_CALL[3]!, 'const earlyEditVerb = /\\b(edit|fix)\\b/i.test(goalForRouting);\n      if (earlyEditVerb && earlyHandoff.target) {');
    expect(wiringOffences(m).length).toBeGreaterThan(0);
  });
  test("MUTANT the branch ignoring the core's route is red", () => {
    expect(wiringOffences(INDEX.replace(MUST_CALL[3]!, "if (earlyHandoff.target) {")).length).toBeGreaterThan(0);
  });
  test("MUTANT inline hydration text is red", () => {
    const m = INDEX.replace(MUST_CALL[5]!, "if (hydFile) goalForRouting = `${goal} (gap cites file: ${hydFile}; fix per gap record: x)`;");
    expect(wiringOffences(m).length).toBeGreaterThan(0);
  });
});
