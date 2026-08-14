// goalHashOf keys on WORK, not surface form (§12.6 step 5): trivial rephrasings — case,
// whitespace runs, line-wrapping — must COALESCE to one cell; genuinely different work must NOT.
import { describe, expect, test } from "bun:test";
import { goalHashOf } from "./goal-target-inference";

describe("goalHashOf — coalesces surface-form rephrasings (step 5)", () => {
  test("case, whitespace runs, and line-wrapping of the SAME work coalesce", () => {
    const base = goalHashOf("Produce a vessel health report for the fleet");
    expect(goalHashOf("produce a vessel health report for the fleet")).toBe(base);      // case
    expect(goalHashOf("Produce  a  vessel   health report for the fleet")).toBe(base);  // whitespace runs
    expect(goalHashOf("Produce a vessel health\nreport for the fleet")).toBe(base);     // line-wrap
    expect(goalHashOf("  Produce a vessel health report for the fleet  ")).toBe(base);  // leading/trailing
  });
  test("genuinely different work does NOT coalesce", () => {
    const a = goalHashOf("Produce a vessel health report for the fleet");
    const b = goalHashOf("Produce a system load report for the fleet");
    expect(a).not.toBe(b);
  });
  test("the output no longer carries a surface-form line-count suffix", () => {
    // prior form returned `${hash}:${lineCount}`; two wrappings of the same text now match exactly
    expect(goalHashOf("a\nb")).toBe(goalHashOf("a b"));
    expect(goalHashOf("x").includes(":")).toBe(false);
  });
});
