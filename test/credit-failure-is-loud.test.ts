import { describe, it, expect } from "bun:test";

/**
 * A SWALLOWED CREDIT IS A REACH THAT TEACHES NOTHING.
 *
 * MEASURED 2026-08-17. A correct compositional reach — 59 + 2 + 6 = 67, verified by an
 * independent oracle — returned `alphaBetaDelta: [{dAlpha: 0, dBeta: 0}]` with NO rejection
 * line anywhere in the journal. The feedback POST had THROWN rather than answering, and the
 * handler was `catch { /* non-fatal *\/ }`: non-fatal to the dispatch, fatal to the learning
 * signal, and silent.
 *
 * The caller then logged "alpha-credited last pick ..." unconditionally, so the journal
 * asserted the OPPOSITE of the delta it had just been handed. A silent failure underneath a
 * success message is strictly harder to find than a silent failure alone — every instrument
 * pointed at the log would confirm the credit landed.
 *
 * These pin both halves: the throw is reported, and the success line is conditional on the
 * delta actually being positive.
 */

const SRC = new URL("../src/index.ts", import.meta.url);
const src = async () => await Bun.file(SRC).text();

describe("credit failures are reported", () => {
  it("THE REGRESSION: the catch is no longer empty", async () => {
    const s = await src();
    const i = s.indexOf("async function creditReachedTemplate");
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 2600);
    expect(block).not.toMatch(/catch \{ \/\* non-fatal, symmetric with penaliseHollowTemplate \*\/ \}/);
    expect(block).toContain("alpha-credit LOST");
  });

  it("the lost-credit message names the endpoint and the consequence", async () => {
    const s = await src();
    const i = s.indexOf("alpha-credit LOST");
    const line = s.slice(i, s.indexOf("\n", i));
    // A warning that says only "failed" sends the reader back to the code. Name where it
    // was going and what it cost.
    expect(line).toContain("ACTIVITY_API_ENDPOINT");
    expect(line).toMatch(/learns nothing|earned nothing/);
  });

  it("THE MISLEADING LOG: 'alpha-credited' is conditional on a positive delta", async () => {
    const s = await src();
    const i = s.indexOf("_abCredit.dAlpha > 0");
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i - 200, i + 600);
    expect(block).toContain("alpha-credit NOT APPLIED");
    expect(block).toContain("alpha-credited last pick");
  });

  it("both outcomes are distinguishable in the journal", async () => {
    // The two strings must differ, or a grep cannot tell a credited reach from a lost one —
    // which is the state this fix exists to end.
    const s = await src();
    expect(s).toContain("alpha-credit NOT APPLIED");
    expect(s).toContain("alpha-credit REJECTED");
    expect(s).toContain("alpha-credit LOST");
  });
});
