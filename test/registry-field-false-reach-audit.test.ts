import { describe, it, expect } from "bun:test";
import { registryFieldFor } from "../src/registry-field";

/**
 * THE ABSTENTION I RELIED ON DID NOT FIRE, AND IT PRODUCED A FALSE REACH.
 *
 * Found by an adversarial audit on 2026-08-17, reproduced on HEAD. Three phrasings were
 * answered with `totalShapes` and then BLESSED — the reach oracle derives its field from
 * this same function, so the answer was confirmed rather than checked:
 *
 *     "How many more shapes than vessels are in the discovery registry?"          -> totalShapes
 *     "In the discovery registry, how many shapes and how many vessels are there?" -> totalShapes
 *     "In the discovery registry, how many shapes are there for every vessel?"     -> totalShapes
 *
 * ROOT CAUSE. `((?:\w+\s+){0,2}\w+)` is greedy AND consuming. On "how many shapes and how
 * many vessels", the first match captures "shapes and how"; matchAll resumes after the
 * consumed span, so the SECOND "how many" is already inside it and never matches. `counted`
 * came out as ["shapes"], `distinctEntities.size === 1`, and the two-entity guard — the
 * whole point of that block — was structurally unreachable for the exact input it was
 * written for.
 *
 * ★ THE GUARD DEPENDED ON THE WINDOW IT WAS GUARDING. Whether two entities are in play is a
 * property of the GOAL, not of what one regex happened to consume. The entity scan is now
 * independent of `counted`.
 *
 * ★ AND TWO-OPERAND GOALS NEED NO ARITHMETIC VERB. "more shapes than vessels" and "shapes
 * for every vessel" name no operator from the divide/ratio/average list, so the second guard
 * missed them too. Both guards failed on the same inputs for different reasons — which is
 * why fixing either alone would have left the class open.
 *
 * The fix is deliberately over-broad: a goal mentioning both nouns abstains even when it
 * asks about one. That direction is cheap and the module says why — "Abstaining costs an LLM
 * judgement; guessing poisons the posterior of an arm that was right."
 */

describe("registry field — the audited false-reach phrasings abstain", () => {
  const AUDITED_FALSE_REACHES = [
    "How many more shapes than vessels are in the discovery registry?",
    "In the discovery registry, how many shapes and how many vessels are there? Report both.",
    "In the discovery registry, how many shapes are there for every vessel?",
  ];

  it("THE REGRESSION: every phrasing the audit reproduced now returns null", () => {
    for (const g of AUDITED_FALSE_REACHES) expect(registryFieldFor(g)).toBeNull();
  });

  it("the entity scan does not depend on the counting window", () => {
    // The precise shape of the original bug: two counting clauses, the second swallowed by
    // the first's greedy capture. If someone reintroduces a window-scoped entity check this
    // is the input that catches it.
    expect(registryFieldFor("how many shapes and how many vessels")).toBeNull();
    expect(registryFieldFor("how many vessels and how many shapes")).toBeNull();
  });

  it("two-operand goals with NO arithmetic verb abstain", () => {
    // Neither of these contains divide/ratio/average/per — the original second guard's
    // entire vocabulary — yet both need two numbers.
    expect(registryFieldFor("how many more shapes than vessels")).toBeNull();
    expect(registryFieldFor("how many shapes for every vessel")).toBeNull();
    expect(registryFieldFor("how many fewer vessels than shapes")).toBeNull();
  });

  it("comparatives abstain even with ONE entity — a delta is not a total", () => {
    // Caught by the comparative guard rather than the entity scan. Answering "how many more
    // shapes than last week" with the current total is the dropped-operand failure with a
    // non-registry second operand, which no entity scan can see.
    expect(registryFieldFor("how many more shapes than last week")).toBeNull();
  });
});

describe("registry field — the fix is additive, not a blanket abstention", () => {
  it("single-entity counting goals still answer", () => {
    expect(registryFieldFor("how many shapes does the registry have")).toBe("totalShapes");
    expect(registryFieldFor("number of vessels")).toBe("totalVessels");
    expect(registryFieldFor("how many healthy vessels")).toBe("healthyCount");
  });

  it("canonical field names still answer", () => {
    expect(registryFieldFor("Report the totalShapes value from the discovery registry")).toBe("totalShapes");
  });

  it("NEGATIVE CONTROL: this suite can distinguish abstain from answer", () => {
    // Guards the whole file. If registryFieldFor were stubbed to `null` every assertion
    // above would pass vacuously, and a blanket abstention is itself a serious regression —
    // it would silently remove the deterministic producer for every registry goal.
    expect(registryFieldFor("how many shapes does the registry have")).not.toBeNull();
    expect(registryFieldFor("how many shapes and how many vessels")).toBeNull();
  });
});
