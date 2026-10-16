// A NON-ATTEMPT OR A REFUSAL IS NAMED STRUCTURALLY, ON WHAT A CALLER READS AT PROBE TIME (CHANGE-30).
//
// development-vessel's check-supply probes a dispatch with GET /executions/:id and reads its fields; it cannot see
// the /run-goal response a minute later. A compose that DEFERRED its landing (BUSY, failure_kind environment), a
// capacity refusal, and the spend-rate breaker's 429 all came back as status "failed", reached false, with the reason
// only in goalReachReason prose, so the caller charged each as a failed attempt and re-sent on its 24 h backoff (or,
// for the 429, on the very next tick: 455 sends of one goal in a day).
//
//   [MUST-FAIL] the outcome rides the whole probe path: GoalSeekResult.outcome -> the dispatch record -> the served
//               GET /executions/:id body (which is built key by key; an unnamed key is dropped silently).
//   [MUST-FAIL] the capacity/deferral returns (early RETRYABLE CAPACITY, both check_supply refusal returns) set it
//               through ONE helper, composeNonAttemptOutcome, and the 429 record carries kind "refused" with the
//               breaker's own retry_after_s.
//   [CONTROL]   the /resolve caller of the breaker still gets its string reason (dispatchRateRefusal unchanged).
//
// Source pins (the module is not imported: importing src/index.ts reads the live dispatch store and arms timers).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const count = (needle: string): number => SRC.split(needle).length - 1;

describe("the dispatch outcome is served where a caller probes", () => {
  it("[MUST-FAIL] GoalSeekResult.outcome is copied onto the record and served by GET /executions/:id", () => {
    expect(SRC).toMatch(/interface GoalSeekResult \{[\s\S]*?\n  outcome\?: DispatchOutcome;/);
    expect(SRC).toMatch(/interface DispatchRecord \{[\s\S]*?\n  outcome\?: DispatchOutcome;/);
    expect(SRC).toContain("if (seek.outcome) record.outcome = seek.outcome;");
    const served = SRC.slice(SRC.indexOf('url.pathname.startsWith("/executions/")'));
    expect(served.slice(0, 2500)).toContain("outcome: record.outcome ?? null,");
  });

  it("[MUST-FAIL] the non-attempt returns name it through one helper; the 429 names its refusal and window", () => {
    expect(SRC).toContain("function composeNonAttemptOutcome(");
    // early RETRYABLE CAPACITY + the two check_supply refusal returns
    expect(count("composeNonAttemptOutcome(earlyBody as Record<string, unknown>)")).toBeGreaterThanOrEqual(2);
    expect(count("composeNonAttemptOutcome(body as Record<string, unknown>)")).toBeGreaterThanOrEqual(1);
    expect(SRC).toMatch(/const outcome: DispatchOutcome = \{ kind: "refused", refuse_class: "spend_rate", retry_after_s: rateDecision!\.retry_after_s \};/);
    expect(SRC).toMatch(/selectedTemplateId: "spend-rate-refused", goalReachReason: reason, outcome \};/);
    expect(SRC).toContain('"Retry-After": String(outcome.retry_after_s)');
  });

  it("[CONTROL] the /resolve caller still receives the breaker's string reason", () => {
    expect(SRC).toMatch(/async function dispatchRateRefusal\(goal: string\): Promise<string \| null> \{/);
    expect(SRC).toContain("const __rateRefusal = await dispatchRateRefusal(String(goal ?? \"\"));");
  });
});
