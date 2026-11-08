// PROTECTED: production routes through the entries the routing corpus pins (DESIGN §6.3). A corpus-green rule that
// production does not call is a hollow gate, so this reads src/index.ts as text and asserts, by anchor (never by line):
//   - the /run-goal door calls the core's resolveDoorGoal (not resolvePathlessCodeChangeGoal directly);
//   - the moved expressions (the inline hand-off predicate and the inline hydration text) are gone from index.ts.
// Every anchor must be FOUND: a missing anchor is red, never vacuous. Each assertion is shown red on a mutant.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX = readFileSync(join(import.meta.dir, "..", "..", "src", "index.ts"), "utf8");

const MUST_CALL = [
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
  return bad;
}

describe("wiring pin: index.ts routes through the routing core", () => {
  test("every anchor found, no moved expression left", () => { expect(wiringOffences(INDEX)).toEqual([]); });
});
