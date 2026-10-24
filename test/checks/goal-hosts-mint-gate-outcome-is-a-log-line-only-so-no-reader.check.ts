import { describe, it, expect } from "bun:test";

describe("mint gate outcome", () => {
  it("is not recorded in the reach verdict body", async () => {
    // Prevent import-time env-gate failures from src/index.ts initialisation paths.
    process.env.LLM_VESSEL_ENDPOINT ??= "http://127.0.0.1:8220";

    const mod = await import("../../src/index.js");

    const body = mod.reachVerdictBody(
      "test-execution-id",
      false,
      null,
      "mint:credit-hold"
    );

    // Ensure we're asserting on the actual body string shape declared by reachVerdictBody.
    expect(typeof body).toBe("string");

    // This assertion is intended to fail: the defect is that the mint gate's decision
    // is only logged to the console, not propagated to the verdict body, so no reader
    // (ribosome, audit, etc.) can see it.
    expect(body).toContain('"mint":"refused:credit-hold"');
  });
});
