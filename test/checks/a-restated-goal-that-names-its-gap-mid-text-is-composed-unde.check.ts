import * as mod from "../../src/compose-gap-id";

describe("composeGapIdOf", () => {
  test("fails now: a restated goal with a structured gap id is attributed to that gap", () => {
    const goal =
      "Edit repos/development-vessel/src/x.ts to fix the budget. This goal is for pull-sync-testgate-budget-starved-development-vessel.";
    const variables = {
      gap_id: "pull-sync-testgate-budget-starved-development-vessel",
    };
    const got = mod.composeGapIdOf(goal, variables);
    expect(got).toBe("pull-sync-testgate-budget-starved-development-vessel");
  });

  test("control: text-based attribution (anchored, investigation, none) is unchanged", () => {
    expect(mod.composeGapIdOf("Close substrate gap zeta-nine: fix it", undefined)).toBe("zeta-nine");
    expect(mod.composeGapIdOf("investigate and decompose gap k-1: break it down", undefined)).toBe("k-1");
    expect(mod.composeGapIdOf("investigate gap a.b before composing this change", undefined)).toBe("a.b");
    const none = mod.composeGapIdOf("Edit repos/development-vessel/src/y.ts to improve logs", undefined);
    expect(none.startsWith("route-edit-")).toBe(true);
  });
});