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

describe("psiInputs — the refusal is scoped to `signature`", () => {
  it("emits completion_shapes WITHOUT a signature when none is usable", () => {
    // NARROWED 2026-08-21 (seam L3-psi-08). This previously asserted {} — the
    // whole payload withheld whenever the signature was unusable. That was too
    // broad, and it was load-bearing: every goal-host call site holds only an
    // 8-hex hash from another namespace, so psiInputs returned {} at all nine,
    // and `completion_shapes` is a CONJUNCT of the server's ψ guard
    // (activities.ts:6841). Measured consequence: 0 blends in 476 recommends.
    //
    // The invariant being protected is "never emit a foreign identifier AS a
    // shape-space signature" — see the WRONG NAMESPACE block below, which still
    // holds. completion_shapes carries no such risk: it is the goal's target
    // shapes, it needs no signature to mean what it means, and the server
    // derives its own signature on this path. Sending R without a fabricated s
    // is strictly more information than sending nothing.
    expect(psiInputs(undefined, ["a"])).toEqual({ completion_shapes: ["a"] });
    expect(psiInputs(null, ["a"])).toEqual({ completion_shapes: ["a"] });
    expect(psiInputs("", ["a"])).toEqual({ completion_shapes: ["a"] });
  });

  it("NEVER emits a signature key when the signature is unusable", () => {
    // The property that must not regress: no fabricated s reaches the store.
    for (const bad of [undefined, null, "", "5282e725", "ZZZZ", "0123456789abcdefff"]) {
      const out = psiInputs(bad as string | null | undefined, ["a"]);
      expect("signature" in out).toBe(false);
    }
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
  it("THE REGRESSION: an 8-hex host-load hash is refused AS A SIGNATURE", () => {
    // The exact live value observed on this fleet. The signature must not be
    // emitted; the direction R still is (see the scoping block above).
    const out = psiInputs("5282e725", ["shapeA"]);
    expect("signature" in out).toBe(false);
    expect(out).toEqual({ completion_shapes: ["shapeA"] });
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
      // Refused AS A SIGNATURE. The direction R still ships — see the scoping
      // block above (seam L3-psi-08).
      expect(psiInputs(bad, ["shapeA"])).toEqual({ completion_shapes: ["shapeA"] });
    }
  });

  it("NEGATIVE CONTROL: the validator can accept as well as reject", () => {
    // Without this, replacing the body with `return {}` passes every assertion above and
    // silently disables psi wiring altogether.
    expect(psiInputs("aaaaaaaaaaaaaaaa", ["s"])).toEqual({
      signature: "aaaaaaaaaaaaaaaa",
      completion_shapes: ["s"],
    });
    // ...and still rejects the foreign one, without swallowing the direction.
    expect("signature" in psiInputs("aaaaaaaa", ["s"])).toBe(false);
  });

  it("omitting the signature lets the server derive its own — and R still ships", () => {
    // POST /recommend derives the signature server-side from the shape pool,
    // "byte-identical to the write path", whenever the caller supplies nothing
    // usable. That is precisely why withholding `completion_shapes` too was
    // unnecessary: the server can be correct about s on its own, but it cannot
    // invent R. Omitting only the signature is what lets it be correct AND
    // leaves the ψ guard satisfiable.
    const out = psiInputs("5282e725", ["shapeA"]);
    expect(Object.keys(out)).toEqual(["completion_shapes"]);
  });
});
