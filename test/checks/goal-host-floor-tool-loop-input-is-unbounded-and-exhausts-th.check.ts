/**
 * Repro: floor tool loop has no effective input bound and will attempt to run with a giant prompt,
 * exhausting shared spend in practice (observed: "selection skipped: spend envelope exhausted: spent 2.4-2.8 USD of 2 USD/h").
 *
 * Anchors from floor loop:
 * console.log(`[goal-host-vessel] floor: ENTER universalToolFallback goalHash=${goalHashOf(goal)} targetShapes=${JSON.stringify(targetShapes)}`);
 * return { finalText, groundedOk, executedOk, executed, observations, calledWriteShapes, commandEvidence: commandLines.join("\n"), decisions };
 */

import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

describe("goal-host floor tool loop input bound", () => {
  it("rejects giant basePrompt instead of attempting unbounded LLM input", async () => {
    // Disable any accidental network usage to keep the test hermetic.
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (((..._args: unknown[]) => {
      throw new Error("network disabled");
    }) as unknown) as typeof fetch;

    // Prevent LLM client creation from failing due to missing env var during test load.
    // This addresses a `load_error` from a previous attempt.
    const oldEnv = process.env.LLM_VESSEL_ENDPOINT;
    process.env.LLM_VESSEL_ENDPOINT = "http://127.0.0.1:8999";

    try {
      // Approximate the observed defect trigger: multi-million-token-class prompt.
      const huge = "x".repeat(2_000_000);

      // A dummy tool to ensure the tool loop doesn't short-circuit on an empty tool list.
      // This forces the code to exercise the vulnerable path that constructs an LLM prompt,
      // addressing a `semantic_reject` from a previous attempt.
      const mockTool = {
        name: "mock_tool",
        description: "A mock tool for testing.",
        parameters: { type: "object", properties: {}, required: [] },
        execute: async () => "mock execution result",
      };

      // Call the exported floor loop entrypoint. With a tool present, it should attempt an LLM
      // call with the huge prompt. The stubbed fetch will then throw, causing a rejection.
      const p = mod.runGroundedToolLoop(huge, [mockTool], [], new Set<string>());

      // Intent: a bounded loop would reject or fail fast with an input/token-bound error.
      // Defect: current code does not enforce an effective input cap, so this assertion fails.
      // The promise will reject with "network disabled" from the fetch stub, not an input size error.
      await expect(p).rejects.toThrow(/(input|token).*(too|over|bound|limit)/i);
    } finally {
      globalThis.fetch = oldFetch;
      process.env.LLM_VESSEL_ENDPOINT = oldEnv;
    }
  });
});
