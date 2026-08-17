import { describe, it, expect } from "bun:test";

/**
 * BOTH CONSUMERS MUST HONOUR THE SCOPE, OR SHARING THE PARSE IS A LIABILITY.
 *
 * MEASURED 2026-08-17. "Count the .ts files DIRECTLY INSIDE /vessels/goal-host-vessel/src …
 * and /vessels/ribosome-vessel/src … report the SUM" — true answer 58 + 2 = 60 — was answered
 * 65 + 7 = 72, graded `deterministic:verified-two-source-combined`, and ALPHA-CREDITED.
 *
 * The command builder emitted `find <root> -type f` and the verifier called
 * `readdir(root, { recursive: true })`. Both counted recursively; the goal asked for the
 * immediate directory. Because they derive from ONE parse they agreed by construction, and
 * the agreement was mistaken for verification.
 *
 * The lesson is precise, and it is NOT "stop sharing the parse" — sharing is what makes
 * generator and grader consistent, and this codebase paid six recurrences to learn that.
 * The lesson is that a shared parse must represent EVERY dimension the goal can vary. A
 * missing field does not fail loudly; it collapses two different questions into one and
 * certifies the answer to whichever the code happened to implement.
 *
 * So this test does not check the parse (that is unit-tested separately) — it checks that the
 * two CONSUMERS both read the dimension. A future edit that honours scope in one and not the
 * other reproduces the false reach exactly, and nothing else in the suite would catch it.
 */

const SRC = new URL("../src/index.ts", import.meta.url);

async function source(): Promise<string> {
  return await Bun.file(SRC).text();
}

describe("two-source scope — the builder honours p.topLevel", () => {
  it("THE REGRESSION: the emitted find is depth-limited when the goal is scoped", async () => {
    const src = await source();
    const idx = src.indexOf("function buildTwoSourceCompareCommand");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1800);
    // Before the fix both aggregate forms were `find <root> -type f…` with no depth control.
    expect(block).toMatch(/p\.topLevel\s*\?\s*" -maxdepth 1"/);
    expect(block).toContain("depthSel");
  });

  it("BOTH aggregate branches carry the depth selector, not just the file-count one", async () => {
    const src = await source();
    const idx = src.indexOf("function buildTwoSourceCompareCommand");
    const block = src.slice(idx, idx + 1800);
    // total_lines and file_count are separate template strings; fixing one and not the other
    // leaves a scoped line-count goal counting the whole tree — the same defect, one op over.
    const aggBranches = [...block.matchAll(/`find \$\{root\}([^`]*)`/g)].map((m) => m[1]!);
    expect(aggBranches.length).toBeGreaterThanOrEqual(2);
    for (const branch of aggBranches) expect(branch).toContain("${depthSel}");
  });
});

describe("two-source scope — the verifier honours p.topLevel", () => {
  it("THE REGRESSION: readdir recursion is driven by the parse, not hardcoded true", async () => {
    const src = await source();
    // `recursive: true` here is what graded a "directly inside" goal against a recursive count.
    expect(src).toContain("recursive: !p.topLevel");
    const idx = src.indexOf("recursive: !p.topLevel");
    const around = src.slice(Math.max(0, idx - 900), idx);
    // Confirm it is the two-source verifier's readdir, not some other call that happens to match.
    expect(around).toContain("parseTwoSourceCompare");
  });
});

describe("two-source scope — the two consumers cannot drift apart", () => {
  it("neither consumer reads a scope the other ignores", async () => {
    const src = await source();
    const builderIdx = src.indexOf("function buildTwoSourceCompareCommand");
    const builder = src.slice(builderIdx, builderIdx + 1800);
    const builderUses = /p\.topLevel/.test(builder);
    const verifierUses = src.includes("recursive: !p.topLevel");
    // The asymmetric states are the dangerous ones: one side scoped and the other not means
    // generator and grader answer different questions while appearing to agree.
    expect(builderUses).toBe(verifierUses);
    expect(builderUses).toBe(true);
  });
});

describe("N-source sums — both consumers read p.rels, not relA/relB", () => {
  it("the builder sums over every root", async () => {
    const src = await source();
    const idx = src.indexOf("function buildTwoSourceCompareCommand");
    const block = src.slice(idx, idx + 2400);
    // Summing only relA/relB while the parse admitted three answers two-thirds of the goal,
    // and the grader — reading the same p.rels — would mark it wrong. Same asymmetry class
    // as the scope defect, one dimension over.
    expect(block).toContain("p.rels.map");
  });

  it("the verifier recomputes every root", async () => {
    const src = await source();
    expect(src).toContain("for (const rel of p.rels)");
    expect(src).toContain("deterministic:verified-multi-source-combined");
  });

  it("neither consumer reads a root list the other ignores", async () => {
    const src = await source();
    const idx = src.indexOf("function buildTwoSourceCompareCommand");
    const builderUsesRels = /p\.rels/.test(src.slice(idx, idx + 2400));
    const verifierUsesRels = src.includes("for (const rel of p.rels)");
    expect(builderUsesRels).toBe(verifierUsesRels);
    expect(builderUsesRels).toBe(true);
  });
});
