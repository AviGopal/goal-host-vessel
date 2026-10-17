// J1: THE FLOOR SEES THE WALK, AND A TOOL CALL KEEPS ITS OWN execution_id. Measured: universalToolFallback's prompt
// carried the goal, a recipe and a code-search seed only; the walk's carried impulses, its not-reached reason and the
// goal's prior-failure feedback were in scope at the call site and never passed. And the floor stamped the dispatch id
// as execution_id OVER the model's args, so `execution_trace {execution_id: E}` read the dispatch's trace, not E.
// Source wiring is read as text (importing src/index.ts arms timers); the renderers are exercised directly.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fwc from "../src/floor-walk-context";
import * as da from "../src/dispatch-attribution";
import { toolPointer } from "../src/resolve-pointer";

const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
const BUDGET = 16_000;
const blockFn = (fwc as unknown as { floorObservationsBlock?: (c: unknown, max: number) => string }).floorObservationsBlock ?? (() => "");
const block = (c: unknown, max = BUDGET) => blockFn(c, max);
const attribution = (da as unknown as { attributionFields?: (p: unknown, d: string | undefined, f: ReadonlySet<string> | null) => Record<string, string> }).attributionFields
  ?? ((_p: unknown, d: string | undefined) => (d ? { execution_id: d } : {}));
const carryOf = (shape: string, content: unknown) => [{ stepId: "producer-x", executionId: "e1", inputShapes: [], consumedLater: [], impulses: [{ id: "i1", metadata: { shape, producedBy: "producer-x", producerExecutionId: "e1" }, content }] }];

describe("the floor is shown what the walk gathered", () => {
  it("[MUST-FAIL] a carried impulse holding the answer (x = 42) is in the floor's observations", () => {
    const b = block({ carry: carryOf("ledgerTally", { x: 42 }) });
    expect(b).toContain("OBSERVATIONS the walk already gathered");
    expect(b).toContain("ledgerTally");
    expect(b).toContain("42");
  });
  it("[MUST-FAIL] the walk's not-reached reason and the goal's prior failures are in it", () => {
    const b = block({ reason: "no producer for parcelCount", priorFeedback: "- (this exact goal) answered from memory" });
    expect(b).toContain("no producer for parcelCount");
    expect(b).toContain("answered from memory");
  });
  it("[PARAPHRASE] the same pool under a differently named shape and reworded reason renders the same facts", () => {
    const b = block({ carry: carryOf("s_k3m9", { total: 42 }), reason: "the walk found nothing to pick" });
    expect(b).toContain("s_k3m9");
    expect(b).toContain("42");
    expect(b).toContain("the walk found nothing to pick");
  });
  it("[HELD-OUT] no walk state: the prompt gains nothing (empty block)", () => {
    expect(block(undefined)).toBe("");
    expect(block({ carry: [], reason: "", priorFeedback: "" })).toBe("");
    // a failed or empty impulse is not an observation
    expect(block({ carry: carryOf("x", {}) })).toBe("");
  });
  it("[WIRING] the floor prompt carries the block; the post-walk site passes carry + reason + feedback; the reuse site passes feedback", () => {
    expect(INDEX).toContain("${investigationSeed}${floorObservationsBlock(walkContext, (await resolveSelectionTuning()).floorObservationsMaxChars)}");
    expect(INDEX).toContain("_ufOut, { carry: walk.carry, reason: walk.goalReachReason ?? null, priorFeedback: priorFailureFeedbackFor(goal) });");
    expect(INDEX).toContain("undefined, { priorFeedback: priorFailureFeedbackFor(goal) });");
    expect(INDEX).toContain("universalToolFallback(goal, targetShapes, dispatchId, out, walkContext)");
  });
});

describe("the observations block is bounded in total, however large the walk's state", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ stepId: `p${i}`, executionId: `e${i}`, inputShapes: [], consumedLater: [], impulses: [{ id: `i${i}`, metadata: { shape: `shape_${i}`, producedBy: `p${i}`, producerExecutionId: `e${i}` }, content: { rows: "x".repeat(6000), marker: `M${i}` } }] }));
  it("[SCALE] a 10x carry (30 large impulses) stays within the shaped budget, keeps the first-carried impulse, and says what it omitted", () => {
    const b3 = block({ carry: many(3) });
    const b30 = block({ carry: many(30) });
    expect(b30.length).toBeLessThanOrEqual(BUDGET + 600);
    expect(b30.length).toBeLessThan(b3.length * 3);
    expect(b30).toContain("M0");
    expect(b30).toMatch(/\(\d+ further observation\(s\) and \d+ further note\(s\) were omitted/);
  });
  it("[HELD-OUT] failure history beyond the budget is cut, and counted, not appended unbounded", () => {
    const fb = Array.from({ length: 400 }, (_, i) => `- (a similar goal) lesson ${i} ${"y".repeat(80)}`).join("\n");
    const b = block({ priorFeedback: fb }, 4_000);
    expect(b.length).toBeLessThanOrEqual(4_000 + 600);
    expect(b).toContain("lesson 0");
    expect(b).toContain("were omitted");
  });
  it("[CONTROL] the budget is the shaped selection-tuning value, read at use time", () => {
    const st = readFileSync(join(import.meta.dir, "..", "src", "selection-tuning.ts"), "utf-8");
    expect(st).toContain("floorObservationsMaxChars: 16_000,");
    expect(st).toContain('floorObservationsMaxChars: resolveField("floorObservationsMaxChars", parsed["floorObservationsMaxChars"]),');
  });
  it("[WIRING] an unreadable resolver_schema is a counted, named fail-open line", () => {
    expect(INDEX).toContain("_resolverSchemaUnreadable++; console.warn(`[dispatch-attribution] resolver_schema unreadable for ${shape}");
  });
});

describe("a tool call's own execution_id is never replaced by the dispatch id", () => {
  it("[MUST-FAIL] a call naming execution_id E keeps E; attribution travels under dispatch_id", () => {
    const f = attribution({ type: "execution_trace", execution_id: "E" }, "D", null);
    expect(f["execution_id"]).toBeUndefined();
    expect(f["dispatch_id"]).toBe("D");
  });
  it("[MUST-FAIL] a call naming none, to a shape whose schema TAKES execution_id, is not handed the dispatch's", () => {
    const f = attribution({ type: "execution_trace" }, "D", new Set(["execution_id", "limit"]));
    expect(f["execution_id"]).toBeUndefined();
    expect(f["dispatch_id"]).toBe("D");
  });
  it("[CONTROL] an attribution-only call (no such input) still gets execution_id = the dispatch, as before", () => {
    expect(attribution({ type: "llm_completion_dispatch", prompt: "p" }, "D", new Set(["prompt"]))).toEqual({ dispatch_id: "D", execution_id: "D" });
    expect(attribution({ type: "shellResult", command: "ls" }, "D", null)).toEqual({ dispatch_id: "D", execution_id: "D" });
  });
  it("[MUST-FAIL] the floor's pointer: the model's execution_id survives (defaults < args < extras, unchanged)", () => {
    // ufExecuteTool now passes the dispatch id as an EXTRA dispatch_id and a DEFAULT execution_id.
    const p = toolPointer("execution_trace", { execution_id: "E" }, { dispatch_id: "D" }, { execution_id: "D" });
    expect(p["execution_id"]).toBe("E");
    expect(p["dispatch_id"]).toBe("D");
    const q = toolPointer("llm_completion_dispatch", { prompt: "p" }, { dispatch_id: "D" }, { execution_id: "D" });
    expect(q["execution_id"]).toBe("D");
    expect(INDEX).toContain("toolPointer(name, args, dispatchContext.getStore()?.dispatchId ? { dispatch_id: dispatchContext.getStore()!.dispatchId } : {}, {");
    expect(INDEX).toContain("Object.assign(pointer, attributionFields(pointer, _did, pointer.execution_id ? null : await resolverSchemaFieldNames(shape)))");
  });
});
