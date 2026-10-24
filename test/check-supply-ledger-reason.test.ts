// WHAT A CHECK-SUPPLY LEDGER LINE SAYS ABOUT ITS COMPOSE (src/check-supply-ledger-reason.ts). Measured: 66 lines read
// "refused at (none)" (an UNFAVORABLE report has no top-level stage), and every caller cut read only "nothing landed for
// <gap>" although the compose recorded its stage and reason on the gap row. The literals asserted here are the ones the
// ledger's readers match.
import { describe, expect, test } from "bun:test";

import { composeReportStage, cutCallerOutcome } from "../src/check-supply-ledger-reason";

const START = Date.parse("2026-10-24T10:00:00Z");
const SEMANTIC = "the diff does not address the gap: the check reads a literal the goal text passes in";
const rowWith = (lessons: unknown[]) => ({ id: "gap-x", classification_metadata: { failure_lessons: lessons } });

describe("[MUST-FAIL] a cut caller's ledger reason names the stage and reason its compose recorded", () => {
  test("the newest lesson since dispatch start, stage=semantic_gate, is reported with its text", () => {
    const row = rowWith([
      { at: "2026-10-24T09:00:00Z", stage: "own_check", reason: "an earlier attempt" },
      { at: "2026-10-24T10:12:00Z", class: "verify_failed", stage: "semantic_gate", reason: SEMANTIC },
    ]);
    const out = cutCallerOutcome(row, START, 342);
    expect(out).toBe(` stage=semantic_gate reason=${SEMANTIC}`);
    expect(out).toContain(" stage=semantic_gate reason=");
  });
  test("the reported outcome is bounded to 300 characters", () => {
    const out = cutCallerOutcome(rowWith([{ at: "2026-10-24T10:12:00Z", stage: "semantic_gate", reason: "x".repeat(2000) }]), START, 342);
    expect(out.length).toBe(300);
    expect(out.startsWith(" stage=semantic_gate reason=x")).toBe(true);
  });
});

describe("[MUST-FAIL] an UNFAVORABLE report with a semantic-gate dissent is refused at semantic_gate, not (none)", () => {
  test("no top-level stage and semantic_gate.addresses === false gives semantic_gate", () => {
    expect(composeReportStage({ ok: false, verdict: "UNFAVORABLE", semantic_gate: { addresses: false, reason: SEMANTIC } })).toBe("semantic_gate");
  });
  test("no stage and no dissent falls to failure_kind, then the verdict", () => {
    expect(composeReportStage({ ok: false, verdict: "UNFAVORABLE", failure_kind: "verify_failed" })).toBe("verify_failed");
    expect(composeReportStage({ ok: false, verdict: "UNFAVORABLE" })).toBe("UNFAVORABLE");
  });
});

describe("CONTROLS", () => {
  test("a stale lesson (older than the dispatch) is never reported as this dispatch's: stage=unknown", () => {
    const out = cutCallerOutcome(rowWith([{ at: "2026-10-24T09:59:59Z", stage: "semantic_gate", reason: SEMANTIC }]), START, 342);
    expect(out).toBe(" stage=unknown (caller cut at 342s, no report)");
  });
  test("an unreadable or missing row gives stage=unknown", () => {
    expect(cutCallerOutcome(null, START, 15)).toBe(" stage=unknown (caller cut at 15s, no report)");
  });
  test("a report that names its stage keeps it", () => {
    expect(composeReportStage({ ok: false, verdict: "REFUSED", stage: "test_writing_diff_outside_tests", semantic_gate: { addresses: false } })).toBe("test_writing_diff_outside_tests");
  });
});
