import { describe, expect, test } from "bun:test";
import { isUsableBudget, resolveWalkBudget, walkBudgetPath } from "./walk-budget";

// The property under test is not "does it parse JSON". It is: an absent or junk budget must be
// INDISTINGUISHABLE FROM NOTHING at the consumer, so the documented literal fallback survives.
// A producer that answers successfully with an unusable body is worse than no producer — it
// silences the fallback log while changing nothing, which is how the reader-without-producer
// miss stayed invisible in the first place.

const VALID = { max_iters: 6, max_calls_per_iter: 12, iter_timeout_ms: 60_000, wall_clock_ms: 180_000 };

describe("isUsableBudget", () => {
  test("accepts a full budget", () => {
    expect(isUsableBudget(VALID)).toBe(true);
  });

  test("accepts a partial budget — the consumer keeps its value for absent fields", () => {
    expect(isUsableBudget({ max_iters: 8 })).toBe(true);
    expect(isUsableBudget({ wall_clock_ms: 120_000 })).toBe(true);
  });

  test("accepts numeric strings, which the consumer coerces", () => {
    expect(isUsableBudget({ max_iters: "8" })).toBe(true);
  });

  test("REJECTS an all-absent budget — resolving 'successfully' with nothing to apply", () => {
    expect(isUsableBudget({})).toBe(false);
    expect(isUsableBudget({ max_iters: null, wall_clock_ms: undefined })).toBe(false);
  });

  test("REJECTS zero or negative fields — max_iters 0 would disable the floor", () => {
    expect(isUsableBudget({ max_iters: 0 })).toBe(false);
    expect(isUsableBudget({ max_calls_per_iter: -1 })).toBe(false);
    expect(isUsableBudget({ ...VALID, wall_clock_ms: 0 })).toBe(false);
  });

  test("REJECTS non-numeric and non-object shapes", () => {
    expect(isUsableBudget({ max_iters: "lots" })).toBe(false);
    expect(isUsableBudget({ max_iters: NaN })).toBe(false);
    expect(isUsableBudget(null)).toBe(false);
    expect(isUsableBudget("6")).toBe(false);
    expect(isUsableBudget([6])).toBe(false);
  });
});

describe("resolveWalkBudget", () => {
  test("serves a stored budget", async () => {
    expect(await resolveWalkBudget("/ws", async () => JSON.stringify(VALID))).toEqual(VALID);
  });

  test("absent file resolves to null, preserving the consumer fallback", async () => {
    expect(await resolveWalkBudget("/ws", async () => { throw new Error("ENOENT"); })).toBeNull();
  });

  test("malformed JSON resolves to null, never half-parsed", async () => {
    expect(await resolveWalkBudget("/ws", async () => "{not json")).toBeNull();
  });

  test("a syntactically valid but unusable budget resolves to null", async () => {
    expect(await resolveWalkBudget("/ws", async () => JSON.stringify({ max_iters: 0 }))).toBeNull();
    expect(await resolveWalkBudget("/ws", async () => JSON.stringify({}))).toBeNull();
  });
});

describe("walkBudgetPath", () => {
  test("resolves under the supplied workspace root", () => {
    expect(walkBudgetPath("/ws")).toBe("/ws/policies/walk-budget.json");
  });

  test("honours WORKSPACE_ROOT — goal-host's unit sets /workspace/git/super-repo, not /workspace", () => {
    const prev = process.env["WORKSPACE_ROOT"];
    process.env["WORKSPACE_ROOT"] = "/workspace/git/super-repo";
    try {
      expect(walkBudgetPath()).toBe("/workspace/git/super-repo/policies/walk-budget.json");
    } finally {
      if (prev === undefined) delete process.env["WORKSPACE_ROOT"];
      else process.env["WORKSPACE_ROOT"] = prev;
    }
  });
});
