import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionTrace } from "@avigopal/ias-executor-ts";

// Finding agf_bgj5catiey2l: a satisfier-reached walk persisted no auditable task trace. Its steps carried only
// their output shape, the durable trace had no answer and no reach_reason on a reach, and the flush + persist
// sat inside the verify try, so a throw there dropped the trace. The floor path is the model (final_text cap,
// reach_reason). The module is imported dynamically so its absence is a test failure, not a load error.
type Mod = typeof import("./satisfier-durable-trace");
const mod = (await import("./satisfier-durable-trace").catch(() => null)) as Mod | null;
const M = (): Mod => { expect(mod).not.toBeNull(); return mod as Mod; };
const SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

const GOAL = "Find an untaken lair in the junkyard where the stimulant crate can sit behind the petticoat rack";

function satisfierStep(n: number, shape: string, bound: string[], content: unknown): ExecutionTrace {
  const t = {
    id: `walk-satisfier-${n}-1000`,
    templateId: `satisfier:${shape}`,
    templateName: `vessel-resolve satisfier (${shape})`,
    status: "completed",
    compositionChain: [],
    inputImpulseIds: [],
    outputImpulseIds: [`imp-${shape}-${n}`],
    tasks: [{ taskId: "satisfier-resolve", description: `resolve ${shape} via connected vessel`, resolverId: shape, resolverTier: "pattern", inputImpulseIds: [], outputImpulseIds: [`imp-${shape}-${n}`], outputShapes: [shape], success: true }],
    costUsd: 0,
    durationMs: 0,
    tags: ["operator:test", "satellite:non_terminal", `satisfier_shape:${shape}`],
    metadata: { satisfier: true, shape },
  } as unknown as ExecutionTrace;
  if (mod) Object.assign(t.metadata as object, mod.satisfierStepAudit(bound, content));
  return t;
}
const steps = (): ExecutionTrace[] => [
  satisfierStep(1, "webSearchResult", [], { results: [{ title: "salvage yard map", url: "https://example.test/yard" }] }),
  satisfierStep(2, "llmCompletion", ["webSearchResult", "webSearchResult"], "The north corner shed is unclaimed."),
];
const ANSWER = `# ${GOAL}\n\nThe north corner shed is unclaimed.\n\n## Basis\n\nsalvage yard map`;

describe("MUST-FAIL (i): a satisfier-reached walk's durable trace carries answer_body and reach_reason", () => {
  test("the reach metadata holds the answer, the reason, and each step's resolver, bound inputs and digest", () => {
    const md = M().satisfierReachMetadata({ reached: true, reachReason: "deterministic:shed-located", answerBody: ANSWER, steps: steps() });
    expect(md.answer_body).toBe(ANSWER);
    expect(md.answer_body_len).toBe(ANSWER.length);
    expect(md.reach_reason).toBe("deterministic:shed-located");
    const s = md.steps as Array<{ resolver: string; bound_inputs: string[]; content_digest: { sha256_16: string; len: number }; output_impulse_ids: string[] }>;
    expect(s.map((x) => x.resolver)).toEqual(["webSearchResult", "llmCompletion"]);
    expect(s[1]!.bound_inputs).toEqual(["webSearchResult"]);
    expect(s[1]!.content_digest.len).toBe("The north corner shed is unclaimed.".length);
    expect(s[1]!.content_digest.sha256_16).toMatch(/^[0-9a-f]{16}$/);
    expect(s[0]!.content_digest.sha256_16).not.toBe(s[1]!.content_digest.sha256_16);
    expect(s[1]!.output_impulse_ids).toEqual(["imp-llmCompletion-2"]);
  });

  test("the answer is capped the floor's way, with the truncation stated", () => {
    const long = "x".repeat(5000);
    const md = M().satisfierReachMetadata({ reached: true, reachReason: "r", answerBody: long, steps: [] });
    expect(M().ANSWER_TEXT_CAP).toBe(4000);
    expect(md.answer_body).toBe(`${"x".repeat(4000)}\n…[truncated 1000 chars]`);
    expect(md.answer_body_len).toBe(5000);
    // the floor's own cap is the model and is unchanged
    expect(SRC).toContain("final_text: finalText.length > 4000 ? `${finalText.slice(0, 4000)}\\n…[truncated ${finalText.length - 4000} chars]` : finalText,");
  });

  test("reach_reason is set on every verdict, and a reach with no rendered body records a pointer", () => {
    const miss = M().satisfierReachMetadata({ reached: false, reachReason: undefined, answerBody: undefined, steps: steps() });
    expect(typeof miss.reach_reason).toBe("string");
    expect(String(miss.reach_reason).length).toBeGreaterThan(0);
    const hit = M().satisfierReachMetadata({ reached: true, reachReason: null, answerBody: "  ", answerPointer: ["imp-llmCompletion-2"], steps: steps() });
    expect(String(hit.reach_reason).length).toBeGreaterThan(0);
    expect(hit.answer_body).toBeNull();
    expect(hit.answer_pointer).toEqual(["imp-llmCompletion-2"]);
  });

  test("wiring: the durable trace and both satisfier step sites carry the audit", () => {
    const i = SRC.indexOf("if (satisfierOnlyTrace) {");
    const block = SRC.slice(i, SRC.indexOf("persistWithinDeadline(persistSatisfierTrace(durableTrace)", i));
    expect(block).toContain("metadata: { ...(lastTrace.metadata ?? {}), ...satisfierReachMetadata({ reached, reachReason: goalReachReason ?? lastTrace.reason, answerBody, answerPointer: lastTrace.outputImpulseIds, steps: satisfierTraces }) },");
    expect(SRC).toContain("Object.assign(synthTrace.metadata ?? (synthTrace.metadata = {}), satisfierStepAudit(stepBound, resolved.content));");
    expect(SRC).toContain("Object.assign(_vrSynthTrace.metadata ?? (_vrSynthTrace.metadata = {}), satisfierStepAudit(stepBound, _vrResolved.content));");
    // each audit lands before the step is queued for the flush
    expect(SRC.indexOf("satisfierStepAudit(stepBound, resolved.content)")).toBeLessThan(SRC.indexOf("satisfierTraces.push(synthTrace);"));
    expect(SRC.indexOf("satisfierStepAudit(stepBound, _vrResolved.content)")).toBeLessThan(SRC.indexOf("satisfierTraces.push(_vrSynthTrace);"));
  });
});

describe("MUST-FAIL (ii): a throw in verify still persists the trace", () => {
  test("an unreached walk whose verify threw persists failed and beta-withheld, with the error as its reason", () => {
    const s = steps();
    const t = M().thrownVerifyDurableTrace(s[1], { reached: false, reachReason: undefined, answerBody: undefined, steps: s, verifyError: "judge view exploded" });
    expect(t).not.toBeNull();
    expect(t!.id).toBe(s[1]!.id);
    expect(t!.status).toBe("failed");
    expect(t!.tags).toContain("beta_withheld:true");
    expect(t!.tags).toContain("beta_withheld_reason:verify-error");
    expect(t!.tags).not.toContain("reached:false"); // a throw is not a verdict: the arm is not blamed
    expect(t!.tags).toContain("satisfier_shape:llmCompletion");
    const md = t!.metadata as Record<string, unknown>;
    expect(String(md.reach_reason)).toContain("judge view exploded");
    expect(md.verify_error).toBe("judge view exploded");
    expect((md.steps as unknown[]).length).toBe(2);
    expect(md.satisfier).toBe(true);
  });

  test("a reach decided before the throw stands, with its answer", () => {
    const s = steps();
    const t = M().thrownVerifyDurableTrace(s[1], { reached: true, reachReason: "deterministic:shed-located", answerBody: ANSWER, steps: s, verifyError: "presentation emit failed" });
    expect(t!.status).toBe("completed");
    expect(t!.tags).toContain("reached:true");
    expect(t!.tags).not.toContain("beta_withheld:true");
    expect((t!.metadata as Record<string, unknown>).answer_body).toBe(ANSWER);
  });

  test("wiring: the verify's catch records the error and a FINALLY flushes and persists after a throw", () => {
    const warn = SRC.indexOf('console.warn("[goal-host-vessel] walk goal-reach verify error (non-fatal):"');
    expect(warn).toBeGreaterThan(-1);
    const head = SRC.slice(warn - 200, warn);
    expect(head).toContain("} catch (e) {\n      walkVerifyError = String((e as Error)?.message ?? e);");
    const fin = SRC.indexOf("} finally {", warn);
    expect(fin).toBeGreaterThan(warn);
    expect(fin - warn).toBeLessThan(200);
    const body = SRC.slice(fin, SRC.indexOf("// BANK GATE", fin));
    expect(body).toContain("if (walkVerifyError !== null) try {");
    expect(body).toContain("await flushSatisfierTraces(lastTrace);");
    expect(body).toContain("thrownVerifyDurableTrace(lastTrace, { reached, reachReason: goalReachReason, answerBody, answerPointer: lastTrace.outputImpulseIds, steps: satisfierTraces, verifyError: walkVerifyError })");
    expect(body).toContain("walkDurableTrace === null");
    expect(body).toContain("await persistWithinDeadline(persistSatisfierTrace(_thrown), (await resolveSelectionTuning()).satisfierFlushDeadlineMs, _thrown.id);");
    // the normal path marks its durable trace started, so the finally never posts a second one
    const i = SRC.indexOf("if (satisfierOnlyTrace) {");
    const block = SRC.slice(i, SRC.indexOf("persistWithinDeadline(persistSatisfierTrace(durableTrace)", i));
    expect(block).toContain("walkDurableTrace = durableTrace;");
  });
});

describe("CONTROL: template-run traces are unchanged", () => {
  test("the durable path stays satisfier-only: the engine already persisted a template run", () => {
    expect(SRC).toContain("const satisfierOnlyTrace = (lastTrace.metadata as { satisfier?: boolean } | undefined)?.satisfier === true;");
    expect(SRC.split("if (satisfierOnlyTrace) {").length - 1).toBe(1);
    expect(SRC).toContain("await persistWithinDeadline(persistSatisfierTrace(durableTrace), (await resolveSelectionTuning()).satisfierFlushDeadlineMs, durableTrace.id);");
  });

  test("a template run whose verify threw gets no satisfier durable trace (new module)", () => {
    const engine = { id: "exec-template-77", templateId: "tpl-yard-survey", status: "completed", tasks: [], tags: ["reached:false"], metadata: { template: true } } as unknown as ExecutionTrace;
    expect(M().isSatisfierOnlyTrace(engine)).toBe(false);
    expect(M().thrownVerifyDurableTrace(engine, { reached: false, reachReason: undefined, answerBody: undefined, steps: [], verifyError: "x" })).toBeNull();
    expect(M().thrownVerifyDurableTrace(null, { reached: false, reachReason: undefined, answerBody: undefined, steps: [], verifyError: "x" })).toBeNull();
    expect(M().isSatisfierOnlyTrace(steps()[0])).toBe(true);
  });
});
