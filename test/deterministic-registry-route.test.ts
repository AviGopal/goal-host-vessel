import { describe, it, expect } from "bun:test";
import { inferGoalTargetDecision } from "../src/goal-target-inference";

/**
 * THE FIX I LANDED FIRST WAS IN THE WRONG COMPONENT.
 *
 * Controlled re-run, 2026-08-17 — identical code, two wordings, minutes apart:
 *
 *   "How many shapes are in the discovery registry?"       -> ["shellResult"] @0.6 -> REACHED
 *   "Report the totalShapes value from the discovery ..."  -> []            @0    -> failed
 *
 * I had already "fixed" this by teaching `registryFieldFor` the canonical field names. A
 * live probe against the running container confirmed the matcher then returned totalShapes
 * for the failing goal — and the live walk kept failing anyway, because the matcher is
 * consulted DOWNSTREAM of the target decision, and the target decision is what was empty.
 *
 * A fix landing in the component that shares the defect's VOCABULARY is not thereby in the
 * component that shares its CONTROL FLOW. The tell was precisely that mismatch: probe green,
 * walk red.
 *
 * These tests therefore assert on inferGoalTargetDecision — the deciding component — with no
 * LLM available, so only the deterministic routes can answer. If they ever start passing via
 * the LLM inferrer they stop testing this.
 */

const KNOWN = ["shellResult", "problem_detection", "memoryNote_write", "codeInsertResult"];
const noLLM = { complete: true } as const;

describe("deterministic registry route — the precise phrasing now routes", () => {
  it("THE REGRESSION: the canonical field name yields a target", async () => {
    const out = await inferGoalTargetDecision(
      "Report the totalShapes value from the discovery registry at http://localhost:18100/registry/stats as a single number.",
      KNOWN, noLLM,
    );
    expect(out.shapes).toEqual(["shellResult"]);
  });

  it("the conversational phrasing still routes — this is additive", async () => {
    const out = await inferGoalTargetDecision("How many shapes are in the discovery registry?", KNOWN, noLLM);
    expect(out.shapes).toEqual(["shellResult"]);
  });

  it("both wordings earn the SAME confidence — they ask the same question", async () => {
    const a = await inferGoalTargetDecision("Report the totalShapes value from the discovery registry", KNOWN, noLLM);
    const b = await inferGoalTargetDecision("How many shapes are in the discovery registry?", KNOWN, noLLM);
    expect(a.confidence).toBe(b.confidence);
  });

  it("the compositional RATIO routes too, via registryRatioFor", async () => {
    const out = await inferGoalTargetDecision(
      "Divide the total number of shapes in the discovery registry by the total number of vessels and report the quotient.",
      KNOWN, noLLM,
    );
    expect(out.shapes).toEqual(["shellResult"]);
  });
});

describe("deterministic registry route — the abstentions it must not reopen", () => {
  /**
   * The whole risk of a new door into shellResult. The producer and the reach oracle share
   * registryFieldFor, so anything routed here is CONFIRMED rather than checked — a goal this
   * route admits but the producer answers only partially becomes a false reach with an
   * oracle's blessing.
   */
  it("COMPUTE-THEN-EMIT abstains — caught by an existing guard on my first version", async () => {
    // "how many vessels ... store the answer in X" asks for a count AND a write. Routing to
    // shellResult answers half. registryFieldFor cannot see this: the counting clause is
    // well-formed and names one entity, so it answers correctly about the only dimension it
    // models. A matcher must not be trusted past the dimension it models.
    const out = await inferGoalTargetDecision(
      "how many vessels are registered? store the answer in a memory note",
      KNOWN, noLLM,
    );
    expect(out.shapes).not.toEqual(["shellResult"]);
  });

  it("the emit guard BINDS where nothing else routes the goal", async () => {
    // Measured, not assumed. This phrasing has no other route, so the guard's effect is
    // visible: without it, registryFieldFor matches "totalShapes" and this would be sent to
    // shellResult, answering the count and dropping "write it to a file".
    const out = await inferGoalTargetDecision("report the totalShapes value and write it to a file", KNOWN, noLLM);
    expect(out.shapes).toEqual([]);
    expect(out.confidence).toBe(0);
  });

  it("PINS A MEASURED LIMIT: the guard is NON-BINDING where an older rule routes first", async () => {
    // I wrote this test twice wrong before measuring. First I asserted `shapes !=
    // ["shellResult"]`; then, when that failed, I assumed a pre-existing rule answered at
    // 0.4 and asserted THAT. Both were guesses about code I had not probed. The measurement:
    //
    //   "report the totalShapes value and write it to a file"  -> []              @0
    //   "count the registry shapes then commit the result"     -> ["shellResult"] @0.6
    //   "how many shapes in the registry? save it"             -> ["shellResult"] @0.6
    //
    // So an EARLIER rule routes the last two at the same 0.6 this route uses, which means
    // confidence cannot discriminate them either. My emit guard genuinely runs and genuinely
    // returns null for these goals — and changes nothing about the outcome. That is the
    // "redundant non-binding guard" class, and the honest record is that this change does
    // NOT close compute-then-emit in general; it closes it only where no earlier rule fires.
    //
    // Pinned rather than fixed: tightening the earlier rule is a separate change with its own
    // blast radius, and claiming an abstention the system does not perform would be worse
    // than the gap being open.
    for (const g of ["count the registry shapes then commit the result", "how many shapes in the registry? save it"]) {
      const out = await inferGoalTargetDecision(g, KNOWN, noLLM);
      expect(out.shapes).toEqual(["shellResult"]);
    }
  });

  it("a goal naming TWO registry fields still abstains", async () => {
    // Inherited free from registryFieldFor, and it must stay inherited: this is the
    // abstention that stopped a real false reach (an operand reported as the quotient).
    const out = await inferGoalTargetDecision("report totalShapes and totalVessels", KNOWN, noLLM);
    expect(out.shapes).not.toEqual(["shellResult"]);
  });

  it("NEGATIVE CONTROL: a non-registry goal is not routed here", async () => {
    // Without this the assertions above could all pass from a route that fires on everything.
    const out = await inferGoalTargetDecision("review this file for code quality problems", KNOWN, noLLM);
    expect(out.shapes).not.toEqual(["shellResult"]);
  });

  it("NEGATIVE CONTROL: no route when shellResult is not an advertised shape", async () => {
    const out = await inferGoalTargetDecision(
      "Report the totalShapes value from the discovery registry",
      ["problem_detection"], noLLM,
    );
    expect(out.shapes).not.toEqual(["shellResult"]);
  });
});
