// THE TEXT-DERIVED GAP ID IS READ ONLY FROM A GOAL THAT LEADS WITH ITS GAP PHRASE. src/compose-gap-id.ts rules that the
// gap id is a structured field, recovered from text in one place only; the phrase parse that remains is anchored, so a
// goal that merely MENTIONS "Close substrate gap X:" mid-sentence is not attributed to X at the composeGapIdOf sites (the
// two feature_compose pointers and the landed-commit probes). Unanchoring it misattributes such a goal's compose,
// failures and closure to whatever gap its prose quotes.
import { describe, expect, test } from "bun:test";
import { composeGapIdOf, gapIdOfGoalText } from "../src/compose-gap-id";
import { goalHashOf } from "../src/goal-target-inference";

const X = "gap-fixture-quoted-mid-sentence";

describe("text-derived gap id is anchored", () => {
  test("[MUST-FAIL] a mid-sentence 'Close substrate gap X:' does not yield X", () => {
    const goal = `Edit repos/goal-host-vessel/src/quiesce.ts to log the drain, then Close substrate gap ${X}: as a follow-up note.`;
    expect(composeGapIdOf(goal, {})).not.toBe(X);
    expect(composeGapIdOf(goal, {})).toBe(`route-edit-${goalHashOf(goal)}`);
    const inv = `Please look at this and investigate and decompose gap ${X}: when you can.`;
    expect(gapIdOfGoalText(inv)).not.toBe(X);
  });
  test("[CONTROL] a leading 'Close substrate gap X:' still yields X, as do the leading investigation phrasings", () => {
    expect(composeGapIdOf(`Close substrate gap ${X}: the drain is not logged.`, {})).toBe(X);
    expect(gapIdOfGoalText(`investigate and decompose gap ${X}: the drain is not logged.`)).toBe(X);
    expect(gapIdOfGoalText(`investigate gap ${X} before composing a fix`)).toBe(X);
  });
});
