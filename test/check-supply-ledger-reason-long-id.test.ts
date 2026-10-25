// A CUT CALLER'S STAGE SURVIVES A LONG GAP ID (src/check-supply-ledger-reason.ts cutCallerReason). The ledger line's
// readers keep a prefix: the supply's ledger keeps the first 240 characters of goalReachReason, POST /reach the first
// 600. With " stage=… reason=…" appended AFTER "nothing landed for <gap id>", a long id pushed the stage past the cut, and
// the ledger again said only "nothing landed". The outcome now comes before the gap id.
import { describe, expect, test } from "bun:test";
import * as mod from "../src/check-supply-ledger-reason";

const START = Date.parse("2026-10-24T10:00:00Z");
const row = { classification_metadata: { failure_lessons: [{ at: "2026-10-24T10:12:00Z", stage: "semantic_gate", reason: "the diff does not address the gap" }] } };
const LEDGER_KEEPS = 240;
const reasonOf = (gapId: string): string => {
  const f = (mod as unknown as { cutCallerReason?: (g: string, o: string) => string }).cutCallerReason;
  if (typeof f !== "function") throw new Error("cutCallerReason is not exported");
  return f(gapId, mod.cutCallerOutcome(row, START, 342));
};

describe("cut caller ledger line", () => {
  test("[MUST-FAIL] a 400-char gap id with stage=semantic_gate: the stored (prefix-kept) reason still names the stage", () => {
    const id = "g".repeat(400);
    const line = reasonOf(id);
    expect(line.slice(0, LEDGER_KEEPS)).toContain("stage=semantic_gate");
    expect(line.slice(0, 600)).toContain("stage=semantic_gate reason=the diff does not address the gap");
  });
  test("[CONTROL] a short gap id gives the same content: the gap id, the stage and reason, and the no-walk clause", () => {
    const line = reasonOf("gap-x");
    expect(line).toContain("early edit-intent routed to feature_compose");
    expect(line).toContain(" stage=semantic_gate reason=the diff does not address the gap");
    expect(line).toContain("the check_supply compose call failed or was refused and nothing landed for gap-x");
    expect(line).toContain("a check-supply goal is never walked or escalated");
  });
});
