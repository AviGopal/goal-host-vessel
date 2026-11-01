import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

describe("deterministic_wrong_derived_value reach metadata", () => {
  it("fails to use byte length for oracle_value with multi-byte subjects", () => {
    const subject = "é"; // 1 UTF-16 character, 2 bytes in UTF-8
    const goal = `deterministic_wrong_derived_value:${subject}`;
    const result = mod.verifyDeterministicCompute(goal, "any-digest");

    // The defect is that oracle_value is derived from UTF-16 string length ('1')
    // instead of byte length ('2'). This assertion for the correct value fails.
    expect(result?.metadata?.oracle_value).toBe(
      String(Buffer.from(subject).length)
    );
    // The defect also hard-codes oracle_verified: true. The corrected code
    // will verify against the command's byte count, so this will pass.
    expect(result?.metadata?.oracle_verified).toBe(true);
  });

  it("correctly computes oracle_value for single-byte subjects", () => {
    const subject = "abc"; // 3 UTF-16 characters, 3 bytes in UTF-8
    const goal = `deterministic_wrong_derived_value:${subject}`;
    const result = mod.verifyDeterministicCompute(goal, "any-digest");

    // For single-byte strings, UTF-16 length and byte length are the same.
    // This test passes now and must continue to pass after the fix.
    expect(result?.metadata?.oracle_value).toBe(
      String(Buffer.from(subject).length)
    );
    expect(result?.metadata?.oracle_verified).toBe(true);
  });
});
