// A not-reached floor's reason SUPERSEDES the walk's. The floor is the last thing a dispatch tried, but it returned null
// on failure and the caller recorded the walk's earlier reason, so a grounded floor answer read as the walk's
// "error-envelope": the record, the reach verdict and the failure memory all carried the wrong attempt's reason.
// Source-only: importing src/index.ts reads the live dispatch store and arms timers, so this file reads the text.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
const at = (needle: string): number => { const i = INDEX.indexOf(needle); expect(i).toBeGreaterThan(0); return i; };

describe("floor reason supersedes the walk's", () => {
  test("[MUST-FAIL on base] the floor hands its not-reached reason out, through the dispatch-context re-entry too", () => {
    expect(INDEX).toContain("async function universalToolFallback(goal: string, targetShapes: string[], dispatchId?: string, out?: { reason?: string; abstain?: boolean }, walkContext?: FloorWalkContext)");
    expect(INDEX).toContain("() => universalToolFallback(goal, targetShapes, dispatchId, out, walkContext))");
  });

  test("the reason is set after the decision, on exactly the floor's not-reached condition, and a null verdict says so", () => {
    const decided = at("const floorReached = _floorV.reached;");
    const set = at("if (out && !(verdict?.reached && floorReached)) out.reason =");
    const reachBranch = at("if (verdict?.reached && floorReached) {");
    expect(set).toBeGreaterThan(decided);
    expect(set).toBeLessThan(reachBranch);
    // the null-verdict wording contains "unreachable", which rememberGoalFailure's environment filter skips
    expect(INDEX.slice(set, set + 400)).toContain('"floor: reach verifier unreachable — verdict unknown"');
  });

  test("[MUST-FAIL on base] the walk caller passes the out object and supersedes the record's reason, keeping the walk's inside", () => {
    // the out object is the 4th argument; the walk context (fd9c272) follows it
    const call = at("const uf = await universalToolFallback(goal, seededOutputShapes ?? [], typeof opts.variables.dispatch_id === \"string\" ? opts.variables.dispatch_id : undefined, _ufOut, ");
    const sup = at("if (!uf?.reached && walk.reached !== true && _ufOut.reason) {");
    expect(sup).toBeGreaterThan(call);
    const block = INDEX.slice(sup, sup + 600);
    expect(block).toContain("walk.walkReachReason = String(walk.goalReachReason || \"no reason recorded\");");
    expect(block).toContain("walk.goalReachReason = `${_ufOut.reason} (walk: ");
    // tapped as NOT REACHED, not HOLLOW: dispatchFailureReasons parses HOLLOW/TRACE FAILED lines, and the final reason
    // already carries the floor's, so the memory takes it once
    expect(block).toContain("floor: NOT REACHED — ${_ufOut.reason}");
    expect(block).not.toContain("HOLLOW —");
  });

  test("[MUST-FAIL on base] the reached-command cache still judges the walk's command on the walk's own reason", () => {
    expect(INDEX).toContain("evictReachedCommand(goalHashOf(record.goal), `reach graded false: ${String((seek.walkReachReason || record.goalReachReason) ?? \"no reason recorded\").slice(0, 120)}`);");
  });

  test("a reached walk (prose-over-source) keeps its reason: the supersede requires walk.reached !== true", () => {
    const sup = at("if (!uf?.reached && walk.reached !== true && _ufOut.reason) {");
    expect(sup).toBeGreaterThan(0);
  });
});
