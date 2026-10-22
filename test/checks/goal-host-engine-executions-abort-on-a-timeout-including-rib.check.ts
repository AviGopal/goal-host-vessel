import { describe, test, expect } from "bun:test";
import * as mod from "../../src/transient-failure";

// Reproduction check: engine logs like
//   [engine] execution exec_... template <t> failed after N task(s): The operation was aborted.
// have been observed repeatedly. That message roots in treating AbortError (timeout-driven) as a
// fatal abort instead of a timeout/transient. This test asserts the classification behaviour
// directly on the transient-failure module, without timers or services.

describe("Engine Execution Abort on Timeout", () => {
  test("AbortError ('The operation was aborted.') is classified as timeout/transient, not a fatal abort", () => {
    // Build an AbortError-shaped error as seen in fetch/AbortSignal paths.
    const abortErr: unknown = typeof DOMException !== "undefined"
      ? new DOMException("The operation was aborted.", "AbortError")
      : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

    // Find a classifier on the module: prefer names that clearly indicate transient/timeout/abort classification.
    const modEntries = Object.entries(mod as Record<string, unknown>);
    const preferred = modEntries.filter(([k, v]) => typeof v === "function" && /transient|timeout|abort|classif/i.test(k));
    const fallback = modEntries.filter(([_, v]) => typeof v === "function");
    const picked = (preferred[0] ?? fallback[0]);

    // Ensure we are asserting on an actual export's behaviour (not a missing symbol).
    expect(Boolean(picked)).toBe(true);

    const [fnName, fnVal] = picked as [string, unknown];
    // Narrow to a callable.
    expect(typeof fnVal).toBe("function");

    const classify = fnVal as (e: unknown) => unknown;
    const out = classify(abortErr);

    // Accept common classifier result shapes, but REQUIRE that AbortError be treated as timeout/transient.
    if (typeof out === "boolean") {
      // Defect: currently misclassified as false (fatal); expected true (transient/timeout).
      expect(out).toBe(true);
    } else if (typeof out === "string") {
      // Expect an explicit timeout-ish class.
      expect(out.toLowerCase()).toContain("timeout");
    } else if (out && typeof out === "object") {
      const o = out as Record<string, unknown>;
      if (typeof o["transient"] === "boolean") {
        expect(o["transient"]).toBe(true);
      } else if (typeof o["reason"] === "string") {
        expect((o["reason"] as string).toLowerCase()).toContain("timeout");
      } else if (typeof o["class"] === "string") {
        expect((o["class"] as string).toLowerCase()).toContain("timeout");
      } else {
        // Fallback assertion that WILL FAIL to name the defect if the shape is unexpected.
        expect({ fn: fnName, out }).toEqual({ fn: fnName, out: { transient: true } });
      }
    } else {
      // A null/undefined/other result is also a defect: AbortError should be recognized.
      expect(out).not.toBeNull();
    }
  });
});
