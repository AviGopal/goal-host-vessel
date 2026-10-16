// A FAVORABLE COMPOSE IS REACHED ONLY ON INDEPENDENT LANDING EVIDENCE (D2 step 1; qa approved 2026-10-16 ~12:00Z).
//
// verifyGoalReached's favorableCompose branch returned reached:true from the digest text alone (FAVORABLE + pushed / a
// new_git_sha), saying "landed on origin/dev" without looking. Now a named new_git_sha must be an ancestor of
// origin/dev in that vessel's clone; otherwise the branch falls through to landedEditOf and the reach gate.
//
//   [MUST-FAIL]  the report says FAVORABLE, pushed, new_git_sha X, but git says X is not on origin/dev -> not confirmed.
//   [CONTROL]    SAME digest, git says X is on origin/dev -> confirmed {vessel, X} (positive control at the same address).
//   [CONTROL]    a report naming no (vessel, sha) pair, or an unsafe vessel name, confirms nothing; a git error confirms
//                nothing; the first confirmed pair wins.
//   [WIRING]     index.ts: the branch awaits the confirmation and returns a reach only with it.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
const CL = (await import("../src/compose-landing-evidence").catch(() => ({}))) as Record<string, any>;
const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

const X = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const DIGEST = `featureComposeReport: {"success":true,"shape":"featureComposeReport","body":{"verdict":"FAVORABLE","cutovers":[{"vessel":"goal-host-vessel","result":{"push_status":"pushed","new_git_sha":"${X}"}}],"semantic_gate":{"verified":true,"reachable_symbols":["VERDICT_DIFF_MARKER"]}}}`;
const gitSays = (onDev: boolean, calls: string[][] = []) => async (args: string[]) => {
  calls.push(args);
  if (args.includes("merge-base")) return { code: onDev ? 0 : 1, stdout: "" };
  return { code: 0, stdout: "" };
};

describe("a favorable compose needs independent landing evidence", () => {
  it("[MUST-FAIL] FAVORABLE + pushed + sha X, X not on origin/dev: not confirmed", async () => {
    expect(typeof CL["confirmComposeLanding"]).toBe("function");
    const calls: string[][] = [];
    expect(await CL.confirmComposeLanding(DIGEST, gitSays(false, calls))).toBeNull();
    expect(calls.some((a) => a.join(" ") === `-C /workspace/git/vessels/goal-host-vessel merge-base --is-ancestor ${X} origin/dev`)).toBe(true);
  });

  it("[CONTROL] the same digest, X on origin/dev: confirmed (positive control at the same address)", async () => {
    expect(typeof CL["confirmComposeLanding"]).toBe("function");
    expect(await CL.confirmComposeLanding(DIGEST, gitSays(true))).toEqual({ vessel: "goal-host-vessel", sha: X });
  });

  it("[CONTROL] no pair, an unsafe vessel name, or a git error confirms nothing", async () => {
    expect(typeof CL["composeLandingClaims"]).toBe("function");
    expect(CL.composeLandingClaims(`{"verdict":"FAVORABLE","push_status":"pushed"}`)).toEqual([]);
    expect(CL.composeLandingClaims(`{"vessel":"../etc","result":{"new_git_sha":"${X}"}}`)).toEqual([]);
    expect(await CL.confirmComposeLanding(`{"verdict":"FAVORABLE","push_status":"pushed"}`, gitSays(true))).toBeNull();
    expect(await CL.confirmComposeLanding(DIGEST, async () => { throw new Error("spawn failed"); })).toBeNull();
  });

  it("[WIRING] the favorableCompose branch reaches only with the confirmation", () => {
    expect(SRC).toContain("_composeLanding = await confirmComposeLanding(dig);");
    expect(SRC).toContain("if (favorableCompose && _composeLanding) {");
    expect(SRC).not.toMatch(/if \(favorableCompose\) \{\n\s+\/\/ STRONG credit/);
  });
});
