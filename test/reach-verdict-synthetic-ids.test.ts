import { describe, it, expect } from "bun:test";

/**
 * A WARNING THAT CRIES WOLF HIDES THE REAL ONE.
 *
 * MEASURED 2026-08-29, 24h of goal-host journal. `deliverReachVerdict` guarded exactly one
 * synthetic execution-id form, the literal `goal-seek:no-trace:`. Every other synthetic form
 * fell through, attempted a POST /reach patch, matched no row, and logged
 * "MATCHED NO ROW — verdict NOT persisted; this execution stays ungraded" — the wording
 * reserved for a REAL grading failure.
 *
 * 50 such warnings. 45 of them were `feature_compose:*` (rejected / busy) and
 * `patch_with_tools:*` — walks that never persisted an execution row, so there was nothing to
 * grade. Because a rejected or busy compose is `reached=false` by construction, this also
 * manufactured a statistically significant artefact: 32.6% of NEGATIVE verdicts "lost" versus
 * 13.0% of positive ones (z = 2.74). That reads exactly like the learner dropping its negative
 * signal, and it cost a real investigation to refute.
 *
 * THE DANGEROUS DIRECTION IS OVER-GUARDING, and these tests exist mainly to pin that. On the
 * same window, ids that graded SUCCESSFULLY were `exec_<base36>` (92),
 * `universal-tool-fallback-<hex>-<hex>` (34), and `walk-satisfier-N-<hex>` (10) — none of them
 * UUIDs, so no "a real id is a UUID" shape test is safe here. `walk-satisfier-` appears in BOTH
 * sets (10 persisted, 5 lost); guarding it would suppress ten real gradings to silence five
 * warnings, turning a visible failure into an invisible one.
 *
 * The bar for adding a prefix is empirical: it must NEVER appear on a `reach-patch ok` line.
 */

const SRC = new URL("../src/index.ts", import.meta.url);
const src = async (): Promise<string> => await Bun.file(SRC).text();

function prefixList(s: string): string {
  const i = s.indexOf("const SYNTHETIC_EXECUTION_ID_PREFIXES");
  expect(i).toBeGreaterThan(-1);
  return s.slice(i, s.indexOf("]", i) + 1);
}

describe("synthetic execution-id guard", () => {
  it("guards the two prefixes that NEVER grade (0 persisted / 45 lost)", async () => {
    const list = prefixList(await src());
    expect(list).toContain("goal-seek:no-trace:");
    expect(list).toContain("feature_compose:");
    expect(list).toContain("patch_with_tools:");
  });

  // The load-bearing assertion. walk-satisfier- graded successfully 10 times in the measured
  // window; guarding it would silence 5 warnings by discarding 10 real verdicts.
  it("does NOT guard walk-satisfier-, which sometimes has a real row", async () => {
    expect(prefixList(await src())).not.toContain("walk-satisfier");
  });

  it("does NOT guard the id forms that always grade", async () => {
    const list = prefixList(await src());
    expect(list).not.toContain("universal-tool-fallback");
    expect(list).not.toContain("exec_");
  });

  it("the skip check consults the list rather than a single hardcoded literal", async () => {
    const s = await src();
    const i = s.indexOf("function deliverReachVerdict");
    const block = s.slice(i, i + 1200);
    expect(block).toContain("SYNTHETIC_EXECUTION_ID_PREFIXES.some");
    // The old single-literal test must be gone, or new forms silently fall through again.
    expect(block).not.toMatch(/executionId\.startsWith\("goal-seek:no-trace:"\)/);
  });

  it("still distinguishes the OTHER skip reasons — a synthetic id is not the only one", async () => {
    // Collapsing these would hide "the walk terminated without grading itself", which is a
    // real defect, behind the benign synthetic-id case.
    const s = await src();
    const i = s.indexOf("function deliverReachVerdict");
    const block = s.slice(i, i + 1200);
    expect(block).toContain("no executionId on the dispatch record");
    expect(block).toContain("the walk terminated without grading itself");
  });
});
