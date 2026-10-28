/* @ts-nocheck
   Repro for: composeReportReason ignores verify[].test_writing and falls back to "verify failed (...)".
   It should surface the test-writing judgement (stage/reason).
*/
import { describe, test, expect } from "bun:test";
import * as mod from "../../src/index.js";

describe("composeReportReason defect: drops verify.test_writing", () => {
  test("expected to include test-writing stage: check_references_missing_export", () => {
    const body = {
      failure_kind: "verify",
      applied: [],
      verify: [
        {
          ok: false,
          vessel: "feature-compose",
          output: "src/x.ts(1,1): error TS1005: ';' expected.\nSD_EXIT=1",
          // The TestWritingJudgement the compose should prioritise (stage + reason).
          test_writing: {
            stage: "check_references_missing_export",
            reason: "missing export for composeReportReason",
          },
        },
      ],
      semantic_gate: null,
    } as Record<string, unknown>;

    const reason = mod.composeReportReason(body);
    // Failing assertion today: composeReportReason returns "verify failed (...)" and does not include the stage.
    expect(reason).toContain("check_references_missing_export");
  });

  // CONTROL for the verify path: a verify failure without test_writing should use the generic message.
  // This addresses the prior rejection's concern about assuming an "unguaranteed structure".
  test("control: verify failure without test_writing falls back to generic message", () => {
    const body = {
      failure_kind: "verify",
      verify: [
        {
          ok: false,
          vessel: "another-vessel",
          output: "some build error\nSD_EXIT=1",
        },
      ],
    } as Record<string, unknown>;

    const reason = mod.composeReportReason(body);
    expect(reason).toContain("verify failed (another-vessel)");
    expect(reason).toContain("some build error");
    expect(reason).not.toContain("check_references_missing_export");
  });

  // CONTROL: unaffected path where an explicit error is present should pass unchanged.
  test("control: returns explicit error unchanged when body.error is present", () => {
    const body = { error: "not-reached: upstream refused" } as Record<string, unknown>;
    expect(mod.composeReportReason(body)).toBe("not-reached: upstream refused");
  });
});
