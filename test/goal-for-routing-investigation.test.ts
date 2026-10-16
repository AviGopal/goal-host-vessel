// An investigation ask is not hydrated with "fix per gap record": that injected an edit verb into diagnosis asks
// ("investigate and decompose gap X") and the edit-intent hand-off sent them to feature_compose (measured 2026-10-16).
import { describe, expect, test } from "bun:test";
import { goalForRoutingOf } from "../src/routing-core/entries";

const H = { cited_file: "repos/example-vessel/src/retry.ts", summary: "the retry cap is not enforced" } as never;

describe("goalForRoutingOf: investigation asks are not hydrated into edits", () => {
  test("[MUST-FAIL] 'investigate and decompose gap X: …' is returned unchanged", () => {
    const g = "investigate and decompose gap gap-example-retry-cap: the retry cap is not enforced.";
    expect(goalForRoutingOf(g, H)).toBe(g);
  });
  test("[MUST-FAIL] 'investigate gap X before composing' is returned unchanged", () => {
    const g = "investigate gap route-edit-abc-step-1 before composing a fix";
    expect(goalForRoutingOf(g, H)).toBe(g);
  });
  test("[CONTROL] a close-gap goal still hydrates with the cited file", () => {
    const g = "Close substrate gap gap-example-retry-cap: the retry cap is not enforced.";
    expect(goalForRoutingOf(g, H)).toContain("gap cites file: repos/example-vessel/src/retry.ts; fix per gap record:");
  });
  test("[CONTROL] an 'address … gap' repair goal still hydrates", () => {
    const g = "Address semantic rejection gap gap-example-retry-cap";
    expect(goalForRoutingOf(g, H)).toContain("gap cites file:");
  });
  test("[CONTROL] a goal that already names a repos file is unchanged", () => {
    const g = "Close gap x by editing repos/example-vessel/src/retry.ts";
    expect(goalForRoutingOf(g, H)).toBe(g);
  });
});
