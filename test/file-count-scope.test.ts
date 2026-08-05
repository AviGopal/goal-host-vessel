// File-count SCOPE regression (2026-08-05, observed live).
//
// The deterministic file-count command builder and its reach oracle
// (verifyCountFilesReach) deliberately share one parse, so they ALWAYS agree. That is
// sound only while the shared rule answers the question the GOAL asked. It did not:
// both hardcoded `-maxdepth 1`, so "Write a memory note recording the current count of
// TypeScript files in repos/goal-host-vessel/src" was answered 10 (files sitting directly
// in src) when the true recursive count is 17. Because the two sides agreed, the walk
// logged "matches verifyCountFilesReach truth by construction" and "independently counted",
// judged the goal REACHED, and ALPHA-CREDITED the arm — promoting a wrong answer to a
// positive learning signal. An oracle that generates what it grades is not an oracle.
//
// These tests pin the SCOPE rule on the command side (the side that is unit-testable
// without a filesystem fixture): recursive by default, depth-1 only when the goal says so.
import { describe, it, expect, beforeAll } from "bun:test";

let buildAggregateCommand: (goal: string) => string | null;

beforeAll(async () => {
  // src/index.ts constructs an LLM port at module load; give it a dummy endpoint so the
  // import evaluates without a live LLM (mirrors deterministic-compute.test.ts). No port bound.
  process.env.LLM_VESSEL_ENDPOINT ??= "http://127.0.0.1:65535";
  const mod: any = await import("../src/index.ts");
  buildAggregateCommand = mod.buildAggregateCommand;
});

describe("buildAggregateCommand — file-count scope", () => {
  it("counts RECURSIVELY by default (the live 10-vs-17 defect)", () => {
    const cmd = buildAggregateCommand("count the .ts files in repos/goal-host-vessel/src");
    expect(cmd).toBeTruthy();
    expect(cmd).not.toContain("-maxdepth 1");
    expect(cmd).toContain("-type f");
    expect(cmd).toContain("-name '*.ts'");
  });

  it("prunes node_modules and .git so the count is not inflated by dependencies", () => {
    const cmd = buildAggregateCommand("how many .ts files are in repos/goal-host-vessel/src");
    expect(cmd).toContain("node_modules");
    expect(cmd).toContain(".git");
    expect(cmd).toContain("-prune");
  });

  // The narrow reading must still be reachable — otherwise this fix just swaps one wrong
  // default for another.
  const TOP_LEVEL_PHRASINGS = [
    "count the top-level .ts files in repos/goal-host-vessel/src",
    "how many .ts files are directly in repos/goal-host-vessel/src",
    "count the .ts files immediately in repos/goal-host-vessel/src",
    "non-recursive count of .ts files in repos/goal-host-vessel/src",
  ];
  for (const goal of TOP_LEVEL_PHRASINGS) {
    it(`uses -maxdepth 1 when the goal scopes to the immediate directory: "${goal.slice(0, 46)}…"`, () => {
      const cmd = buildAggregateCommand(goal);
      expect(cmd).toBeTruthy();
      expect(cmd).toContain("-maxdepth 1");
    });
  }

  it("keeps the recursive aggregate ops recursive (they always were)", () => {
    const cmd = buildAggregateCommand("total lines in repos/goal-host-vessel/src .ts files");
    if (cmd) expect(cmd).not.toContain("-maxdepth 1");
  });
});

// Extension-FILTER regression (2026-08-05, observed live immediately after the scope fix).
// Fixing the depth did not fix the class. "How many TypeScript files are under
// repos/goal-host-vessel/src?" still answered 18 for a tree holding 17 .ts files plus one
// .js, because the extension parse only matched a dotted literal (".ts files") and the word
// "TypeScript" left ext=null => count EVERY file. The oracle shares the parse, so it agreed
// on 18 and alpha-credited the wrong answer again — the same self-confirming shape in a
// second dimension. While generator and grader share a parse, ANY parse error is invisible.
describe("buildAggregateCommand — extension filter from language names", () => {
  it("maps 'TypeScript files' to *.ts (the live 18-vs-17 defect)", () => {
    const cmd = buildAggregateCommand("how many TypeScript files are under repos/goal-host-vessel/src");
    expect(cmd).toBeTruthy();
    expect(cmd).toContain("-name '*.ts'");
  });

  it("still honours the dotted literal form", () => {
    const cmd = buildAggregateCommand("how many .ts files are under repos/goal-host-vessel/src");
    expect(cmd).toContain("-name '*.ts'");
  });

  it("does not confuse JavaScript with TypeScript", () => {
    const cmd = buildAggregateCommand("how many JavaScript files are under repos/goal-host-vessel/src");
    expect(cmd).toContain("-name '*.js'");
    expect(cmd).not.toContain("-name '*.ts'");
  });

  it("counts ALL files when the goal names no file type", () => {
    const cmd = buildAggregateCommand("how many files are under repos/goal-host-vessel/src");
    expect(cmd).toBeTruthy();
    expect(cmd).not.toContain("-name '*.");
  });
});
