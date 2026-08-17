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
    const out = psiInputs("sig-abc", ["shapeA", "shapeB"]);
    expect(out).toEqual({ signature: "sig-abc", completion_shapes: ["shapeA", "shapeB"] });
    // The whole defect was a plausible-looking near-miss on these names.
    expect(Object.keys(out)).not.toContain("state_signature");
    expect(Object.keys(out)).not.toContain("expected_output_shapes");
  });

  it("accepts a Set, because the walk holds `target` as one", () => {
    expect(psiInputs("s", new Set(["x"]))).toEqual({ signature: "s", completion_shapes: ["x"] });
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
    expect(psiInputs("s", undefined)).toEqual({});
    expect(psiInputs("s", [])).toEqual({});
    expect(psiInputs("s", new Set())).toEqual({});
  });

  it("emits NOTHING when the direction holds only unusable entries", () => {
    // `completion_shapes.length > 0` is the store's guard; an array of empty strings passes
    // a length check and produces a zero reward vector — present but meaningless.
    expect(psiInputs("s", ["", ""])).toEqual({});
    expect(psiInputs("s", [undefined as unknown as string])).toEqual({});
  });

  it("drops unusable entries but keeps the rest", () => {
    expect(psiInputs("s", ["", "real", null as unknown as string])).toEqual({
      signature: "s",
      completion_shapes: ["real"],
    });
  });
});
