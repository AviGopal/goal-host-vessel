import { describe, expect, test } from "bun:test";
import * as mod from "../../src/compose-gap-id";

describe("compose gap id attribution for goals", () => {
  test("fails now: a restated code-change goal naming its gap mid-text is attributed to that gap", () => {
    const goal =
      "Edit repos/development-vessel/src/x.ts to fix the budget. Close substrate gap pull-sync-testgate-budget-starved-development-vessel: the gate starves";
    const got = mod.gapIdOfGoalText(goal);
    expect(got).toBe("pull-sync-testgate-budget-starved-development-vessel");
  });

  test("control: anchored and investigation phrasings still map; no-gap yields a route-edit-<hash>", () => {
    expect(mod.gapIdOfGoalText("Close substrate gap zeta-nine: fix it")).toBe("zeta-nine");
    expect(mod.gapIdOfGoalText("investigate and decompose gap k-1: break it down")).toBe("k-1");
    expect(mod.gapIdOfGoalText("investigate gap a.b before composing this change")).toBe("a.b");
    const none = mod.gapIdOfGoalText("Edit repos/development-vessel/src/y.ts to improve logs");
    expect(none.startsWith("route-edit-")).toBe(true);
  });
});
