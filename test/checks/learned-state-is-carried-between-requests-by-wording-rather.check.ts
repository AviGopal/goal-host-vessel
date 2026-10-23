import { test, expect } from "bun:test";

test("learned state is not carried between requests by wording", async () => {
  // Prior attempts to run this test failed with a load-time error:
  // "createLLMPort: LLM_VESSEL_ENDPOINT is not set...".
  // This happens because importing 'src/index.ts' has side-effects, including
  // initializing an LLM client which requires configuration.
  // To solve this, we set the required environment variable and then use a
  // dynamic import() to load the module, ensuring the environment is configured
  // before the module's top-level code executes.
  process.env.LLM_VESSEL_ENDPOINT = "http://127.0.0.1:8220";
  const mod = await import("../../src/index");

  // This test reproduces the "learned state is carried between requests BY WORDING"
  // defect, where failure recall is incorrectly keyed on the first word of a goal.

  // 1. Remember a failure for a specific goal.
  mod.rememberGoalFailure(
    "What is the capital of France?",
    [], // walkLog
    "failed for test", // finalReason
    "test-pick", // pick
    ["navigation.search"], // shapes
    1, // attempts
  );

  // 2. Recall failures for a DIFFERENT goal that starts with the same word.
  const recalledShapes = mod.recallGoalFailures(
    "What is the weather like in Paris?",
    [], // walkLog
    null, // finalReason
    null, // pick
    null, // shapes
    0, // attempts
  );

  // 3. Expect no failures to be recalled, as this is a new, distinct goal.
  // The test fails if the implementation incorrectly uses the first word ("What")
  // as a key and recalls the failure from the first goal.
  expect(recalledShapes).toEqual([]);
});
