import { describe, it, expect } from "bun:test";
import { psiInputs } from "../src/psi-inputs";

/**
 * The behavioural half of the ψ-wiring fix.
 *
 * The call-site test (psi-goal-direction-reaches-the-store.test.ts) can only prove that
 * `psiInputs(...)` is INVOKED with a direction. What the helper then emits is the part that
 * decides whether the store's guard fires, and it is exactly the part a source-scanning test
 * cannot see. Without this file, replacing the helper body with `return {}` would leave the
 * whole suite green while ψ went back to zero — a detector that cannot fail.
 */

describe("psiInputs — the exact key names the store destructures", () => {
  it("emits `signature` and `completion_shapes`, not `state_signature`/`expected_output_shapes`", () => {
    const out = psiInputs("0123456789abcdef", ["shapeA", "shapeB"]);
    expect(out).toEqual({ signature: "0123456789abcdef", completion_shapes: ["shapeA", "shapeB"] });
    // The whole defect was a plausible-looking near-miss on these names.
    expect(Object.keys(out)).not.toContain("state_signature");
    expect(Object.keys(out)).not.toContain("expected_output_shapes");
  });

  it("accepts a Set, because the walk holds `target` as one", () => {
    expect(psiInputs("0123456789abcdef", new Set(["x"]))).toEqual({ signature: "0123456789abcdef", completion_shapes: ["x"] });
  });
});

describe("psiInputs — all-or-nothing", () => {
  it("emits NOTHING when the signature is missing", () => {
    // A payload with completion_shapes and no signature fails the store's guard silently
    // while reading, to a human, as though ψ were requested.
    expect(psiInputs(undefined, ["a"])).toEqual({});
    expect(psiInputs(null, ["a"])).toEqual({});
    expect(psiInputs("", ["a"])).toEqual({});
  });

  it("emits NOTHING when the direction is missing or empty", () => {
    expect(psiInputs("0123456789abcdef", undefined)).toEqual({});
    expect(psiInputs("0123456789abcdef", [])).toEqual({});
    expect(psiInputs("0123456789abcdef", new Set())).toEqual({});
  });

  it("emits NOTHING when the direction holds only unusable entries", () => {
    // `completion_shapes.length > 0` is the store's guard; an array of empty strings passes
    // a length check and produces a zero reward vector — present but meaningless.
    expect(psiInputs("0123456789abcdef", ["", ""])).toEqual({});
    expect(psiInputs("0123456789abcdef", [undefined as unknown as string])).toEqual({});
  });

  it("drops unusable entries but keeps the rest", () => {
    expect(psiInputs("0123456789abcdef", ["", "real", null as unknown as string])).toEqual({
      signature: "0123456789abcdef",
      completion_shapes: ["real"],
    });
  });
});

describe("psiInputs — a signature from the WRONG NAMESPACE is refused, not truncated", () => {
  /**
   * Found by adversarial audit. The first version of this module passed
   * `getCachedStateSignature()?.signature_hash` — sha1 of load average / memory / trace
   * counters, sliced to 8 hex chars. psi cells are keyed by sha256(shapes|provenance|missing)
   * .digest().slice(0,8) = 16 hex chars. Different algorithm, different width, different
   * SUBJECT. No width fix could make them meet.
   *
   * The harm was the shape of the miss, not the miss: the store gated only on
   * `signature.length > 0`, so the foreign value passed, every lookup missed, and every
   * candidate came back `successor_value: {value: 0}` — reported as a measurement of zero
   * occupancy rather than as a lookup that never happened.
   */
  it("THE REGRESSION: an 8-hex host-load hash is refused", () => {
    // The exact live value observed on this fleet.
    expect(psiInputs("5282e725", ["shapeA"])).toEqual({});
  });

  it("a 16-hex shape-space signature is accepted", () => {
    expect(psiInputs("0123456789abcdef", ["shapeA"])).toEqual({
      signature: "0123456789abcdef",
      completion_shapes: ["shapeA"],
    });
  });

  it("refuses anything that is not exactly 16 lowercase hex", () => {
    for (const bad of [
      "5282e725",                    // 8 hex — the incident
      "0123456789abcde",             // 15
      "0123456789abcdef0",           // 17
      "0123456789ABCDEF",            // uppercase
      "0123456789abcdeg",            // non-hex
      "activity:0123456789abcdef",   // wrapped
    ]) {
      expect(psiInputs(bad, ["shapeA"])).toEqual({});
    }
  });

  it("NEGATIVE CONTROL: the validator can accept as well as reject", () => {
    // Without this, replacing the body with `return {}` passes every assertion above and
    // silently disables psi wiring altogether.
    expect(psiInputs("aaaaaaaaaaaaaaaa", ["s"])).not.toEqual({});
    expect(psiInputs("aaaaaaaa", ["s"])).toEqual({});
  });

  it("sending NOTHING is the correct fallback, and it is what refusal produces", () => {
    // POST /recommend derives the signature server-side from the shape pool, "byte-identical
    // to the write path", whenever the caller supplies nothing usable. So an empty object is
    // not a degraded request — it is the request that lets the server be correct.
    const out = psiInputs("5282e725", ["shapeA"]);
    expect(Object.keys(out)).toEqual([]);
  });
});
