// Does symptom→file resolution GENERALIZE, or did one task work by luck?
//
// Measured 2026-08-10 across six real backlog tasks, each phrased the way an
// operator phrases them — a SYMPTOM, no path, no symbol, no shape. Before the
// symbol-name search these resolved to nothing at all; after it, 3 of 6 land on
// the file that actually contains the defect.
//
// This file pins that corpus so the number cannot drift silently. It is a
// CORPUS test, not a unit test: the cases are real, the expectations are the
// measured outcome including the failures, and a change that moves any line
// must move it deliberately.
//
// ★ Two of these were scored as HITS by an earlier version of this probe that
// only checked whether the resolved path started with the expected vessel
// prefix. Both were the wrong FILE. A prefix match is not a hit — every
// expectation below names a file, never a directory.
import { describe, expect, test } from "bun:test";
import {
  isPathlessCodeChangeGoal,
  resolvePathlessCodeChangeGoal,
  type FileSearch,
} from "./goal-file-resolution";

/**
 * A stand-in workspace: symbol declarations and file text for the handful of
 * files these goals can reach. Hand-built rather than grepping the real tree,
 * because a test that shells out to the checkout measures the checkout (and
 * fails on any machine whose tree differs) instead of measuring the resolver.
 * The counts mirror what was measured live.
 */
const DECLARES: Record<string, string[]> = {
  "repos/activity-api/src/models/schemas.ts": ["timestamp", "schema"],
  "repos/activity-api/src/utils/observed-shapes.ts": ["timestamp"],
  "repos/activity-api/src/models/execution.ts": ["schema"],
  "repos/discovery-vessel/src/index.ts": ["endpoint", "register"],
  "repos/discovery-vessel/src/resolvers.ts": ["endpoint"],
  "repos/goal-host-vessel/src/index.ts": ["policy", "honesty"],
};

const symbolSearch: FileSearch = async (word, vessel) =>
  Object.entries(DECLARES)
    .filter(([path, words]) => (!vessel || path.startsWith(`repos/${vessel}/`)) && words.includes(word))
    .map(([path]) => path);

/** No phrase in a symptom goal matches file text — that is the whole premise. */
const noPhrase: FileSearch = async () => [];

const target = (restated: string): string | null => restated.match(/^Edit (\S+)/)?.[1] ?? null;

describe("symptom goals resolve to the file that owns the defect", () => {
  test("#9 — timestamps serializing as empty braces finds TimestampSchema's file", async () => {
    const goal =
      "In the activity api, timestamps come back from the database as objects and end up serialized as empty braces instead of a date. Fix the schema code that normalizes those timestamp values so they serialize as real dates.";
    expect(isPathlessCodeChangeGoal(goal)).toBe(true);
    const out = await resolvePathlessCodeChangeGoal(goal, noPhrase, undefined, symbolSearch);
    // "timestamp" declares in 2 files and "schema" in 3; schemas.ts is the only
    // file in BOTH, so corroboration picks it where no single word could.
    expect(target(out)).toBe("repos/activity-api/src/models/schemas.ts");
  });

  test("#61 — the honesty-policy fallback finds the walk's file", async () => {
    const goal =
      "The walk falls back to a hardcoded list of denial fields because the body honesty policy is not advertised. Make the goal host code read that policy as a shaped impulse.";
    const out = await resolvePathlessCodeChangeGoal(goal, noPhrase, undefined, symbolSearch);
    expect(target(out)).toBe("repos/goal-host-vessel/src/index.ts");
  });

  test("a goal naming no locatable symbol is DECLINED, not guessed", async () => {
    // #45 in the live corpus. Every candidate word is either filler or matches
    // nothing declared, so the fail-closed rule returns the goal untouched —
    // the property that makes widening the resolver safe.
    const goal =
      "When the rhythm registry is empty or cannot be mapped the development vessel fails silently instead of saying so. Make that code report the empty registry.";
    expect(await resolvePathlessCodeChangeGoal(goal, noPhrase, undefined, symbolSearch)).toBe(goal);
  });

  test("KNOWN LIMIT: an unnamed predicate has no symbol to find", async () => {
    // #12 and #59 both failed live, and this is why: they describe a BEHAVIOUR
    // OF A VALUE ("credits a truncated completion as success") whose governing
    // code is a conditional inside a large function, not a declaration. Symbol
    // search finds declarations. Asserted as a decline so the boundary is
    // recorded rather than rediscovered — if a future change makes this
    // resolve, that is progress and this test should be updated deliberately.
    const goal =
      "The activity api credits a completion as a success even when the model stopped because it hit the token limit, so truncated output counts as a win. Fix the code that records that outcome.";
    const out = await resolvePathlessCodeChangeGoal(goal, noPhrase, undefined, symbolSearch);
    // Nothing in DECLARES carries these words; the resolver must not invent one.
    expect(out).toBe(goal);
  });
});
