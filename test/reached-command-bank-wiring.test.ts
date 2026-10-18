// THE REACHED-COMMAND BANK — WIRING (source pins on index.ts; the walk is a closure that cannot run without the fleet).
// Measured: a judge-credited wrong answer was banked on one "yes" and replayed at attempt 2 of the same dispatch,
// because the bank site had no basis gate. A retry after an in-dispatch failure skips only the banked command whose
// replay failed in this dispatch, and sets no ablation flag (a disableReuse retry discarded a verified retrieval).
import { describe, expect, test } from "bun:test";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;

describe("reached-command bank is gated, and a retry skips only the banked command that failed in this dispatch", () => {
  test("[MUST-FAIL on parent] the walk's bank site calls shouldBank on the final deterministic reach, before the bank", () => {
    const decl = src.indexOf("let walkReachDeterministic = false;");
    const set = src.indexOf("walkReachDeterministic = reached === true && isDeterministicVerdict(verdict);");
    const gate = src.indexOf("shouldBank({ deterministic: walkReachDeterministic, independentConcurring: false })");
    const bank = src.indexOf("reachedCommandCache.set(goalHashOf(goal), {");
    expect(decl).toBeGreaterThan(0);
    expect(set).toBeGreaterThan(decl);
    expect(gate).toBeGreaterThan(set);
    expect(bank).toBeGreaterThan(gate);
    expect(src.slice(gate, bank)).toContain("if (_bankBasis) {");
  });
  test("[MUST-FAIL on parent] every bank write carries its basis", () => {
    expect(src).toContain("goalText: goal, basis: _bankBasis, strikes: 0 });");
    expect(src).toContain("goalText: goal, basis: _bankBasis }); // durable known-command library");
    expect(src).toContain('goalText: goal, basis: "concurring" as const };');
  });
  // REPLACES the pin "the retry and reframe walks after an in-dispatch failure run with reuse disabled" (it asserted
  // three `disableReuse: true` retry sites). That ablation discarded a VERIFIED retrieval on a feedback retry; the
  // ruling is that ablation flags are never set on a production dispatch. The retries skip only what failed.
  test("[MUST-FAIL on parent and on 1b08b1e] no retry after an in-dispatch failure sets an ablation flag", () => {
    expect(src.match(/ablation: \{ \.\.\.\(opts\.ablation \?\? \{\}\), disableReuse: true \},/g)).toBeNull();
    const fb = src.indexOf("const fbWalk = await runGoalAsPoolWalk(goal, {");
    const sat = src.indexOf("const retryWalk = await runGoalAsPoolWalk(goal, {");
    const alt = src.indexOf("const altWalkResult = await runGoalAsPoolWalk(goal, {");
    for (const at of [fb, sat, alt]) {
      expect(at).toBeGreaterThan(0);
      const call = src.slice(at, src.indexOf("});", at));
      expect(call).toContain("ablation: opts.ablation,");
      expect(call).toContain("skipFailedReplays: [..._failedReplays]");
      expect(call).not.toContain("disableReuse");
    }
  });
  test("[MUST-FAIL on parent] each attempt's failed replays are accumulated for the next attempt", () => {
    expect(src).toContain("const _failedReplays: FailedReplay[] = [];");
    for (const w of ["walk", "fbWalk", "retryWalk", "altWalkResult"]) expect(src).toContain(`_noteFailedReplays(${w});`);
    // The walk reads its replays against the success ledger at return.
    expect(src).toContain("failedReplays: failedBankReplays(bankReplays, executorCommands),");
  });
  test("[MUST-FAIL on parent] a banked command is skipped only when it failed in this dispatch, with a counted log line", () => {
    const hit = src.indexOf("const _rcFailed = ");
    expect(hit).toBeGreaterThan(0);
    expect(src.slice(hit, hit + 300)).toContain("replayBlocked(opts.skipFailedReplays, shape, _rcHitRaw.command)");
    expect(src).toContain("const _rcHit = _suppressReuse || _rcFailed ? undefined : _rcHitRaw;");
    expect(src).toContain("replayBlocked(opts.skipFailedReplays, shape, _rebindRaw.command)");
    expect(src.match(/\(skip \$\{\+\+failedReplaysSkipped\} this walk\) — it FAILED earlier in this dispatch/g)?.length).toBe(2);
    // Both banked-replay branches note what they replayed.
    expect(src).toContain("bankReplays.set(shape, _rcHit.command);");
    expect(src).toContain("bankReplays.set(shape, _rebind.command);");
  });
  test("control: the first walk is unchanged — reuse off only on an exact-hash failure history, and no skip list", () => {
    expect(src).toContain("ablation: _priorExactFailures > 0 ? { ...(opts.ablation ?? {}), disableReuse: true } : opts.ablation,");
    const first = src.indexOf("let walk = await runGoalAsPoolWalk(goal, {");
    expect(first).toBeGreaterThan(0);
    expect(src.slice(first, src.indexOf("// ABSTAIN (§9.2): the gate declined", first))).not.toContain("skipFailedReplays");
  });
});
