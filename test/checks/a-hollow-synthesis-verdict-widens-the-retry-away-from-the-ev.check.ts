import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

describe("a-hollow-synthesis-verdict widens the retry away from the EV", () => {
  it("records a hollow retry that widens target shapes and logs attemptCount", () => {
    // Reproduction: web_search returned real dated results twice; judge hollow because no synthesis step;
    // re-run with suppressSatisfierShapes and WIDEN target shapes to [shellResult,httpResponse,webSearchResult].
    const walkLog: readonly unknown[] = [
      "web_search returned real dated results (2024-10-01)",
      "web_search returned real dated results (2024-10-01)",
      "judge: hollow — nothing synthesized an answer",
      "re-running with suppressSatisfierShapes",
      "retry WIDENED target shapes to [shellResult,httpResponse,webSearchResult]",
      // shape-only activity drift (simulated)
      ...Array.from({ length: 38 }, (_, i) => `shape-only selection run ${i + 1}: http_response backfill`),
    ];
    const finalReason = "hollow_synthesis";

    // Dispatch failure summarization (pure; no network).
    const reasons = mod.dispatchFailureReasons(walkLog, finalReason);
    // Defect: the retry widens to shellResult/httpResponse/webSearchResult without a synthesizer step.
    // This assertion intentionally fails under the defect (guard reason absent).
    expect({ hasGuard: reasons.some(r => typeof r === "string" && r.includes("suppressSatisfierShapes")) })
      .toEqual({ hasGuard: true });

    // Failure memory should carry attemptCount=2 and the widened shapes (defect: currently not recorded coherently).
    const recorded = mod.rememberDispatchFailures(
      "News-goal replay on node 2 after b260a15",
      walkLog,
      finalReason,
      null,
      ["shellResult", "httpResponse", "webSearchResult"],
      2
    );
    // Assert via object property (not directly on array/string).
    expect({
      attemptTagged: recorded.some(r => typeof r === "string" && r.includes("attemptCount=2")),
      widenedTagged: recorded.some(r => typeof r === "string" && r.includes("webSearchResult")),
    }).toEqual({ attemptTagged: true, widenedTagged: true });
  });
});
