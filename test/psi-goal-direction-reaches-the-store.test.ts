import { describe, it, expect } from "bun:test";

/**
 * THE WALK MUST SEND THE GOAL DIRECTION UNDER THE KEY THE STORE READS.
 *
 * MEASURED 2026-08-17, from the architecture docs rather than from anything failing.
 *
 * SUBSTRATE_AS_MDP.md §12.1 is explicit that the successor-feature cell ψ is the ONLY
 * genuine multi-step structure in this system: "the load-bearing mechanism is a contextual
 * Beta-Bernoulli Thompson-sampling bandit … Actions score immediate reward without a
 * bootstrapped next-state value … One partial exception exists: the successor-feature cell
 * ψ (§2.2) does model the discounted multi-step shape-occupancy of the continuation."
 *
 * §2.2 gives ψ's readout: Q_sf = ⟨ψ(s,a), R⟩, where s is the state `signature` and R is
 * the goal direction "built from the reach gate's `completion_shapes`". The store computes
 * it in `discover-by-shapes` under exactly this guard:
 *
 *     isCandidatesMode && successorFeaturesEnabled()
 *       && typeof signature === 'string' && signature.length > 0
 *       && completion_shapes.length > 0
 *
 * The walk satisfied NONE of the last two, at every call site, for two independent reasons:
 *
 *   1. it sent the state under `state_signature`; the service destructures `signature`.
 *   2. it never sent `completion_shapes` at all — although it holds the goal's target shape
 *      set in `target`, which IS R.
 *
 * And on the recommend fallback the same direction went out as `expected_output_shapes`,
 * which that route destructures as a SEPARATE field from `completion_shapes`; no aliasing.
 *
 * EACH IS INDEPENDENTLY SUFFICIENT TO ZERO ψ, so fixing any one changes nothing — the same
 * amputated-in-series shape as the argument chain and the composition-score blend. ψ was
 * fully built, default-enabled, and structurally unreachable from the only caller that
 * walks. This test pins the request payload, because that is where all three defects lived
 * and where nothing else in the suite looks.
 *
 * NOTE ON WHAT THIS DOES *NOT* ASSERT. It does not claim ψ improves selection. §2.2 is
 * clear that the recommend-side blend is "a gated selection-layer refinement whose default
 * preserves the pure Thompson order byte-for-byte". Supplying the inputs makes ψ COMPUTABLE
 * and observable; enabling the blend is a separate, deliberate act. Wiring an input is not
 * turning on a behaviour, and conflating the two is how an unmeasured change gets credited.
 */

const SRC = new URL("../src/index.ts", import.meta.url);

async function source(): Promise<string> {
  return await Bun.file(SRC).text();
}

/** Every `discover-by-shapes` request body literal in the walk. */
function discoverBodies(src: string): string[] {
  const out: string[] = [];
  const marker = "/v2/activities/discover-by-shapes";
  let i = src.indexOf(marker);
  while (i !== -1) {
    // The body: JSON.stringify({...}) sits within the fetch options that follow the URL.
    const window = src.slice(i, i + 900);
    const b = window.indexOf("body: JSON.stringify({");
    if (b !== -1) {
      const start = b + "body: JSON.stringify(".length;
      // Balanced-brace scan, so a nested `...(cond ? {a} : {})` spread cannot truncate it.
      let depth = 0;
      let end = start;
      for (; end < window.length; end++) {
        const ch = window[end];
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) { end++; break; } }
      }
      out.push(window.slice(start, end));
    }
    i = src.indexOf(marker, i + marker.length);
  }
  return out;
}

describe("psi readout — the walk supplies the inputs the store's guard requires", () => {
  it("guards the instrument: the scan finds every discover-by-shapes call site", async () => {
    const bodies = discoverBodies(await source());
    // If this scan silently found nothing, every assertion below would pass vacuously —
    // which is precisely how a payload-shaped defect stays invisible to a source test.
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    // And it must really be capturing the body, not an empty slice.
    for (const b of bodies) expect(b).toContain("required_shapes");
  });

  /** The one scored call site with NO goal direction to send, named rather than skipped.
   *
   *  `required_shapes: [shape]` is the gap-filing producer lookup — "does anything produce
   *  this shape at all?" It is not a walk step: there is no goal, so there is no R, and
   *  psiInputs' all-or-nothing rule says the honest payload is ψ-less rather than one
   *  carrying a signature against an empty direction. Carving it out BY ITS PAYLOAD keeps
   *  the exemption narrow — a future scored call cannot inherit it by accident. */
  const NO_GOAL_DIRECTION = "required_shapes: [shape]";

  function walkScoredBodies(src: string): string[] {
    return discoverBodies(src)
      .filter((b) => b.includes("include_scores"))
      .filter((b) => !b.includes(NO_GOAL_DIRECTION));
  }

  it("the carve-out is real and singular — exactly one scored site has no goal direction", async () => {
    const scored = discoverBodies(await source()).filter((b) => b.includes("include_scores"));
    const exempt = scored.filter((b) => b.includes(NO_GOAL_DIRECTION));
    // If this ever exceeds one, the exemption has started absorbing real walk steps, which
    // is how a narrow carve-out becomes the silent default.
    expect(exempt.length).toBe(1);
    expect(walkScoredBodies(await source()).length).toBeGreaterThanOrEqual(3);
  });

  it("THE REGRESSION: every scored walk call sends `signature`, not only `state_signature`", async () => {
    for (const b of walkScoredBodies(await source())) {
      // `state_signature` is the cts lookup key and stays. `signature` is what the ψ guard
      // destructures. Sending only the former reads to a human as "the signature is set".
      expect(b).toMatch(/(?<!state_)\bsignature:|psiInputs\(/);
    }
  });

  it("THE REGRESSION: every scored walk call sends `completion_shapes` (the goal direction R)", async () => {
    for (const b of walkScoredBodies(await source())) {
      expect(b).toMatch(/completion_shapes|psiInputs\(/);
    }
  });

  it("EVERY recommend fallback names the direction `completion_shapes` too", async () => {
    const src = await source();
    const marker = "/v2/activities/recommend";
    const windows: string[] = [];
    for (let i = src.indexOf(marker); i !== -1; i = src.indexOf(marker, i + marker.length)) {
      const w = src.slice(i, i + 900);
      // PROSE MENTIONS ARE NOT CALL SITES. The first draft of this scan matched a comment
      // describing the endpoint and reported it as an unpatched request — the same class as
      // grepping `key:` and getting declarations. A request has a stringified body.
      if (!w.includes("body: JSON.stringify(")) continue;
      // A VARIABLE BODY IS OPAQUE TO A SOURCE SCAN. One site posts `JSON.stringify(body)`
      // where `body` was assembled key-by-key further up; its keys are simply not in this
      // window, so asserting on them here would fail for a reason that has nothing to do
      // with the defect. That site is checked at its BUILDER in the test below instead —
      // an instrument that cannot see a thing must say so, not report it absent.
      if (/body: JSON\.stringify\(body\)/.test(w)) continue;
      windows.push(w);
    }
    // Checking only the FIRST occurrence is how "1 of 8 push sites" happened here before.
    expect(windows.length).toBeGreaterThanOrEqual(3);
    for (const w of windows) {
      // `expected_output_shapes` is a real, separately-destructured field on that route and
      // legitimately stays; what must ALSO be present is the key ψ actually reads.
      expect(w).toContain("expected_output_shapes");
      expect(w).toMatch(/completion_shapes|psiInputs\(/);
    }
  });

  it("the key-by-key recommend builder names completion_shapes too", async () => {
    const src = await source();
    // "An explicit projection is a silent dropper": this builder emits only the keys it
    // names, and omitting an optional one is legal — no error, no warning, no failing test.
    // The type that feeds it proves nothing. So assert on the construction site directly.
    const i = src.indexOf("body.expected_output_shapes = [requiredShape]");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 700);
    expect(block).toContain("psiInputs(");
  });

  it("NEGATIVE CONTROL: the signature matcher rejects a state_signature-only body", () => {
    // Without this the previous assertion is untrustworthy: a regex that matched
    // `state_signature:` would report the defective payload as fixed. Prove it can fail.
    const defective = `{ required_shapes: [x], include_scores: true, state_signature: s }`;
    const fixed = `{ required_shapes: [x], include_scores: true, signature: s }`;
    expect(/(?<!state_)\bsignature:/.test(defective)).toBe(false);
    expect(/(?<!state_)\bsignature:/.test(fixed)).toBe(true);
  });
});
