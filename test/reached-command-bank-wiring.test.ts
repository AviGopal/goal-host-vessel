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
    // Three counted skip lines: the exact hit, the lexical rebind, and the family recipe (answer + recovery share one).
    expect(src.match(/\(skip \$\{\+\+failedReplaysSkipped\} this walk\) — it FAILED earlier in this dispatch/g)?.length).toBe(3);
    // Both banked-replay branches note what they replayed.
    expect(src).toContain("bankReplays.set(shape, _rcHit.command);");
    expect(src).toContain("bankReplays.set(shape, _rebind.command);");
  });
  // THE FAMILY RECIPE IS A REPLAY TOO. Its two paths (the recipe answer and the recipe recovery after exhausted
  // self-correction) did not consult the failed list, so a shellResult command that failed earlier in the dispatch and
  // equals recipeCommandFor(goal) was replayed on the retry; and the recipe answer was never noted, so its own
  // failure could not be recorded at all.
  test("[MUST-FAIL on 0fdd24c] a recipe command that failed earlier in the dispatch is not replayed on the retry", () => {
    const ans = src.indexOf('recipeCommandFor(goal) !== null && !_recipeFailedHere(recipeCommandFor(goal)!, "answer")) {');
    expect(ans).toBeGreaterThan(0);
    // The recipe answer is noted, so a failed recipe answer is recorded for the next attempt.
    expect(src.slice(ans, ans + 600)).toContain("bankReplays.set(shape, _rc);");
    expect(src).toContain('if (_recovery && _recovery !== (directArgsRaw["command"] as string | undefined) && !_recipeFailedHere(_recovery, "recovery")) {');
    expect(src).toContain("if (!bankReplays.has(shape)) bankReplays.set(shape, _recovery);");
    const helper = src.indexOf("const _recipeFailedHere = (cmd: string, where: string): boolean => {");
    expect(helper).toBeGreaterThan(0);
    expect(src.slice(helper, helper + 400)).toContain("replayBlocked(opts.skipFailedReplays, shape, cmd)");
  });
  // A source pin, red on 0fdd24c (it names the new condition), not a behavioural control.
  test("[PIN] a recipe is blocked only by a recorded failure — the recipe gates are otherwise unchanged", () => {
    // Still gated on !_suppressReuse and shellResult as before; the only added condition is the failed-list check.
    expect(src).toContain('} else if (!_suppressReuse && shape === "shellResult" && recipeCommandFor(goal) !== null && !_recipeFailedHere(');
    expect(src).toContain('if (_deg && !_suppressReuse && shape === "shellResult") {\n        const _recovery = recipeCommandFor(goal);');
  });
  // THE FLOOR SEED IS THE THIRD RECIPE CONSUMER. It ran recipeCommandFor(goal) and handed the output to the floor as "A
  // VERIFIED MEASUREMENT" without consulting the failed list, so a recipe the walk had just blocked was still the floor's
  // verified value on the retry.
  test("[MUST-FAIL on 0fb57bd] a recipe that failed in this dispatch is not seeded into the floor's verified block on the retry", () => {
    const seed = src.indexOf("const rc = recipeCommandFor(goal);");
    const gate = src.indexOf('const _seedFailed = rc ? replayBlocked(walkContext?.skipFailedReplays, "shellResult", rc) : undefined;', seed);
    const run = src.indexOf('await ufExecuteTool("shellResult", { command: rc }', seed);
    const verified = src.indexOf("A VERIFIED MEASUREMENT for this class of goal", seed);
    expect(seed).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(seed);
    expect(run).toBeGreaterThan(gate);
    expect(verified).toBeGreaterThan(run);
    expect(src.slice(gate, run)).toContain("if (rc && !_seedFailed) {");
    expect(src.slice(gate, run)).toContain("floor: NOT seeding the family recipe");
    // The post-walk floor (the retry's floor) is handed the dispatch's failed replays.
    expect(src).toContain("priorFeedback: priorFailureFeedbackFor(goal), skipFailedReplays: [..._failedReplays] });");
  });
  test("control: the first walk is unchanged — reuse off only on an exact-hash failure history, and no skip list", () => {
    expect(src).toContain("ablation: _priorExactFailures > 0 ? { ...(opts.ablation ?? {}), disableReuse: true } : opts.ablation,");
    const first = src.indexOf("let walk = await runGoalAsPoolWalk(goal, {");
    expect(first).toBeGreaterThan(0);
    expect(src.slice(first, src.indexOf("// ABSTAIN (§9.2): the gate declined", first))).not.toContain("skipFailedReplays");
  });
});
