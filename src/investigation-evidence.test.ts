import { describe, it, expect } from "bun:test";
import { namedFileInGoal, buildInvestigationGrepCommand, VESSELS_ROOT } from "./investigation-evidence";

// The investigation floor greps the goal's symbols and hands the result to the drafter as the
// evidence it must ground on. The original command excluded nothing and truncated at 2000
// chars, so the budget went to @types/node and @typescript-eslint dist rules. Measured
// in-container for (failed_attempts|parentId|parentSummary): with node_modules excluded there
// are 79 real matches, 24 in the file the goal named — but that file first appears at byte
// 3047, so exclusion ALONE still leaves zero of them inside the cut. Both halves are required.
describe("namedFileInGoal", () => {
  it("extracts a repos/ path and maps it onto the clone root", () => {
    expect(namedFileInGoal("Close gap X: edit repos/development-vessel/src/resolvers/gap-to-feature.ts to fix it"))
      .toBe(`${VESSELS_ROOT}/development-vessel/src/resolvers/gap-to-feature.ts`);
  });

  it("accepts the vessels/ spelling too", () => {
    expect(namedFileInGoal("investigate vessels/goal-host-vessel/src/index.ts"))
      .toBe(`${VESSELS_ROOT}/goal-host-vessel/src/index.ts`);
  });

  it("returns null when the goal names no file — symbol-only investigations still work", () => {
    // Must not invent a path: those goals depend entirely on the fleet-wide sweep.
    expect(namedFileInGoal("investigate why universal-tool-fallback never reaches")).toBeNull();
    expect(namedFileInGoal("look at repos/development-vessel")).toBeNull(); // vessel, not a file
  });

  it("refuses path traversal rather than sanitising it", () => {
    // Goal text is untrusted and this value is interpolated into a shell command.
    expect(namedFileInGoal("edit repos/x/../../etc/passwd.ts")).toBeNull();
  });
});

describe("buildInvestigationGrepCommand", () => {
  const GOAL_WITH_FILE = "Close gap: edit repos/development-vessel/src/resolvers/gap-to-feature.ts";

  it("excludes node_modules and friends — the defect that ate the whole budget", () => {
    const cmd = buildInvestigationGrepCommand("failed_attempts|parentId", GOAL_WITH_FILE);
    expect(cmd).toContain("--exclude-dir=node_modules");
    expect(cmd).toContain("--exclude-dir=.git");
    expect(cmd).toContain("--exclude-dir=dist");
    expect(cmd).toContain("--exclude-dir=.bun-cache");
  });

  it("puts the NAMED FILE before the fleet-wide sweep", () => {
    // head -c keeps a PREFIX, so ordering is what decides what survives truncation. This is
    // the half that exclusion alone does not fix: the named file sat at byte 3047.
    const cmd = buildInvestigationGrepCommand("failed_attempts", GOAL_WITH_FILE);
    const named = cmd.indexOf("gap-to-feature.ts");
    const wide = cmd.indexOf(`${VESSELS_ROOT}/ `);
    expect(named).toBeGreaterThan(-1);
    expect(wide).toBeGreaterThan(-1);
    expect(named).toBeLessThan(wide);
  });

  it("still runs the fleet-wide sweep when a file is named", () => {
    // The named file is a priority, not a restriction — call sites elsewhere still matter.
    const cmd = buildInvestigationGrepCommand("failed_attempts", GOAL_WITH_FILE);
    expect(cmd).toContain(`${VESSELS_ROOT}/ `);
  });

  it("degrades to the fleet-wide search when the goal names no file", () => {
    const cmd = buildInvestigationGrepCommand("someSymbol", "investigate someSymbol");
    expect(cmd).toContain(`${VESSELS_ROOT}/ `);
    expect(cmd).toContain("--exclude-dir=node_modules");
    expect(cmd).not.toContain("[ -f ");
  });

  it("guards a named file that does not exist in the clone", () => {
    // Renamed or mistyped paths must fall through to the sweep, not error the whole seed.
    const cmd = buildInvestigationGrepCommand("x", GOAL_WITH_FILE);
    expect(cmd).toContain("[ -f ");
  });

  it("bounds the total and caps the named-file half", () => {
    const cmd = buildInvestigationGrepCommand("x", GOAL_WITH_FILE, { budgetBytes: 2000, namedFileBytes: 1200 });
    expect(cmd).toContain("head -c 1200");
    expect(cmd).toContain("head -c 2000");
  });

  it("never lets the named-file cap exceed the total budget", () => {
    const cmd = buildInvestigationGrepCommand("x", GOAL_WITH_FILE, { budgetBytes: 500, namedFileBytes: 9999 });
    expect(cmd).toContain("head -c 500");
    expect(cmd).not.toContain("head -c 9999");
  });

  it("single-quotes the pattern so goal-derived symbols cannot break out", () => {
    const cmd = buildInvestigationGrepCommand("foo'; rm -rf /; echo '", "investigate foo");
    // The injected quote must be escaped, never left to terminate the literal.
    expect(cmd).not.toContain("'; rm -rf /; echo ''");
    expect(cmd).toContain(`'\\''`);
  });
});

describe("named-file matches carry their filename", () => {
  it("uses grep -H so single-file matches are still file:line", () => {
    // `grep -n` on ONE file omits the filename, yielding bare `725:...` lines. The seed
    // prompt requires a file:line citation and the citation oracle re-reads the cited path,
    // so unlabelled lines fail verification even when the evidence is correct. Found by
    // executing the generated command in-container, not by reading it.
    const cmd = buildInvestigationGrepCommand("failed_attempts", "edit repos/development-vessel/src/resolvers/gap-to-feature.ts");
    expect(cmd).toContain("grep -Hn -E");
  });
});
