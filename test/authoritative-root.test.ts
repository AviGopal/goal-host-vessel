// Which TREE a file-aggregate goal is measured against.
//
// `repos/*` are git SUBMODULES. The super-repo working tree only advances when a gitlink bump
// is committed, so it lags origin/dev by however long since the last bump. What host-pull-sync.sh
// fast-forwards against origin/dev is `/workspace/git/vessels/<vessel>`, and feature_compose
// refreshes that same clone before drafting. Measured 2026-08-05: 9 of 18 vessels drifted, and
// they were exactly the actively-developed ones — development-vessel's submodule was 150 commits
// (6 days) behind. A live count goal answered 392 against the stale tree where origin/dev held
// 377, and the walk credited it as `deterministic:verified-file-count` — a stale answer laundered
// as verified, rewarding the posterior. The oracle even cross-checked the /vessels mirror (which
// reported the correct 377) and resolved the disagreement backwards.
//
// These tests pin the ROOT CHOICE itself, which the golden command strings cannot: a golden that
// embeds a root asserts the bytes agree, not that the tree is the right one. Gap:
// reach-oracle-counts-stale-super-repo-submodule.
// IMPORT NOTE (mirrors reach-routes-golden.test.ts): src/index.ts guards its HTTP boot behind
// import.meta.main, but createLLMPort needs an LLM endpoint present at module evaluation (a lazy
// HttpLLMPort — no connection is opened). Set the env first, then dynamic-import.
import { describe, expect, it } from "bun:test";
process.env.LLM_VESSEL_ENDPOINT ??= "http://127.0.0.1:65535";
const idx: any = await import("../src/index.ts");
const { buildAggregateCommand, buildAvgThresholdCommand, buildRankAggregateCommand, buildTwoSourceCompareCommand } = idx;

const CLONE = "/workspace/git/vessels/development-vessel/src";
const SUPER = "/workspace/git/super-repo/repos/development-vessel/src";

describe("file-aggregate goals are rooted at the pull-sync clone, not the stale submodule", () => {
  const COUNT = "How many TypeScript files are under repos/development-vessel/src?";

  it("prefers the per-vessel clone over the super-repo submodule", () => {
    const cmd = buildAggregateCommand("How many total lines are in the TypeScript files under repos/development-vessel/src?");
    expect(cmd).toContain(CLONE);
    // The clone must be the PREFERRED branch, not merely present: it has to appear before the
    // super-repo path in the `[ -d X ] && echo X || echo Y` selection.
    expect(cmd!.indexOf(CLONE)).toBeLessThan(cmd!.indexOf(SUPER));
  });

  it("still falls back to the super-repo path, so a vessel with no clone behaves as before", () => {
    const cmd = buildAggregateCommand("How many total lines are in the TypeScript files under repos/development-vessel/src?");
    expect(cmd).toContain(SUPER);
  });

  // The regression this file exists to prevent. A bare super-repo root — one not guarded by a
  // clone-existence check — is the exact shape of the defect: it measures whatever the submodule
  // pointer happens to reference.
  it("never roots at the submodule unconditionally", () => {
    for (const cmd of [
      buildAggregateCommand(COUNT),
      buildAggregateCommand("How many total lines are in the TypeScript files under repos/development-vessel/src?"),
      buildRankAggregateCommand("What is the total number of lines in the 3 largest TypeScript files under repos/development-vessel/src?"),
      buildAvgThresholdCommand("How many TypeScript files under repos/development-vessel/src have more lines than the average?"),
    ]) {
      expect(cmd).not.toBeNull();
      expect(cmd).toContain(`[ -d ${CLONE} ]`);
    }
  });

  it("applies to BOTH sides of a two-source comparison", () => {
    const cmd = buildTwoSourceCompareCommand(
      "Which has more TypeScript files, repos/development-vessel/src or repos/goal-host-vessel/src?",
    );
    expect(cmd).toContain("/workspace/git/vessels/development-vessel/src");
    expect(cmd).toContain("/workspace/git/vessels/goal-host-vessel/src");
  });

  // A non-`repos/` path has no per-vessel clone to prefer, so it must be left exactly as it was —
  // the change is a re-ordering of candidates, never a removal of the only one that worked.
  it("leaves a non-repos path untouched", () => {
    const cmd = buildAggregateCommand("How many total lines are in the TypeScript files under vessels/foo/src?");
    if (cmd !== null) {
      expect(cmd).toContain("/workspace/git/super-repo/vessels/foo/src");
      expect(cmd).not.toContain("/workspace/git/vessels/foo/src ]");
    }
  });
});
