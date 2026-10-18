// A GAP INVESTIGATION IS GRADED BY ITS PRODUCT BEFORE THE WRITE GATE (CHANGE-36a; RUN 1 attempt 1, qa 2026-10-16 ~19:0xZ).
//
// The write gate (`if (writeEvidence)` -> judge.reachGate) returned BEFORE the CHANGE-35 gap-investigation gate. A gap
// goal's text carries the gap's first sentence, and an imperative there (": add the resolver", ": Repair needed") trips
// the open rule's IMPERATIVE_CHANGE_LEAD, so the goal graded write-goal-no-artifact:change although its only target,
// gapDecomposition, is not a mutation shape and can never satisfy the write rule (RUN 1 pos 11, 17). This drives the
// REAL gate (index.ts verifyGoalReached) with every fetch stubbed; the gap store read is answered by the stub.
//
//   [MUST-FAIL] "investigate and decompose gap X: … add the resolver …", writeEvidence {persistedWrites: [], targets:
//               [gapDecomposition]}, pool gapDecomposition {gap_id X, created [X-step-1]}, the store holds X-step-1 as X's
//               child -> REACHED by gap-investigation-product (on the parent: write-goal-no-artifact:change).
//   [CONTROL]   the same goal with no product in the pool -> NOT reached, gap-investigation-no-product (deterministic).
//   [MUST-FAIL] NO FIELD (the original, unwrapped call: no dispatch context, e.g. /resolve without a dispatch id, an
//               unreadable gap store at admission, a lost store): still not write-goal-no-artifact. Graded on the normal
//               judge path, with no abstain. (It cannot be graded against X: with no field, X exists only in the prose.)
//               The judge must actually be asked (counted), so a null verdict cannot pass it.
//   [MUST-FAIL] the exemption is keyed on the TARGET SHAPES, not the prose: a goal that reads as an investigation but
//               targets a non-gap shape meets the write gate. (A non-investigation imperative goal is answered by the
//               edit-intent gate before the write gate, so the exempt side is the gapDecomposition cases above.)
//   [MUST-FAIL] field present but the gap store unreadable: the exemption is taken, warned, and the judge grades.
//   [WIRING]    the gap gate sits above the write gate in index.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFetch = globalThis.fetch;
const prevRoot = process.env["WORKSPACE_ROOT"];
const root = mkdtempSync(join(tmpdir(), "gap-before-write-"));
type Gate = (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string, commandEvidence?: string, walkEvidence?: unknown, judgeView?: unknown, deliverables?: string[], poolEvidence?: unknown, writeEvidence?: { persistedWrites: string[]; targets?: string[]; landed?: boolean }, captureSurface?: string) => Promise<{ reached?: boolean; reason?: string; deterministic?: boolean } | null>;
let verifyGoalReached: Gate;
// The gap is the dispatch's structured decompose_gap_id, carried on the dispatch context (the gate reads only the field).
let dispatchContext: { run: <T>(store: { dispatchId: string; decomposeGapId?: string }, fn: () => T) => T };
const X = "gap-lane-picks-a-fixed-gap";
const STEP = `${X}-step-1`;
// The LLM judge, as in citation-oracle-culpability: counted, and it answers not-reached (non-deterministic).
const JUDGE_MARK = "You verify whether a substrate execution REACHED";
let judgeCalls = 0;

beforeAll(async () => {
  mkdirSync(join(root, "policies"), { recursive: true });
  process.env["WORKSPACE_ROOT"] = root;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
    if (body.includes(JUDGE_MARK)) {
      judgeCalls++;
      const verdict = JSON.stringify({ reached: false, reason: "stub judge: not enough", completion_shapes: [] });
      return json({ content: { body: { content: verdict } }, body: { content: verdict } });
    }
    if (body.includes('"vesselCapability"') && body.includes('"llm_completion"')) {
      return json({ content: { vessels: [{ id: "llm-test-vessel", endpoint: "http://llm-vessel.test.invalid", resolve_endpoint: "http://llm-vessel.test.invalid/resolve", protocol: "http" }] } });
    }
    if (String(url).includes("/v2/impulses/resolve") && body.includes('"substrateGap"') && body.includes(STEP)) {
      return new Response(JSON.stringify({ success: true, body: { gaps: [{ id: STEP, classification_metadata: { parent_gap_id: X } }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "stub: not served" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  const mod = (await import("../src/index")) as Record<string, unknown>;
  verifyGoalReached = mod["verifyGoalReached"] as Gate;
  dispatchContext = mod["dispatchContext"] as typeof dispatchContext;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

const GOAL = `investigate and decompose gap ${X}: the lane re-picks a gap whose fix already landed; add the resolver check before the pick`;
const pool = (created: string[]) => created.length ? [{ id: "imp-1", shape: "gapDecomposition", content: { body: { ok: true, gap_id: X, children: created, created, reason: "wrote steps" } } }] : [];
const grade = (created: string[]) => dispatchContext.run({ dispatchId: "d-before-write", decomposeGapId: X }, () => verifyGoalReached(GOAL, ["gapDecomposition"], "walk(1 steps): decomposeGap", "- gapDecomposition: {...}", undefined, undefined, undefined, undefined, pool(created), { persistedWrites: [], targets: ["gapDecomposition"] }, "walk"));

describe("a gap investigation is graded by its product before the write gate", () => {
  test("[MUST-FAIL] an imperative in the gap's text does not make it a write goal: its confirmed product reaches", async () => {
    const v = await grade([STEP]);
    expect(v?.reason ?? "").toContain("gap-investigation-product");
    expect(v?.reached).toBe(true);
  });

  test("[CONTROL] no product in the pool: not reached, gap-investigation-no-product", async () => {
    const v = await grade([]);
    expect(v?.reached).toBe(false);
    expect(v?.reason ?? "").toContain("gap-investigation-no-product");
  });

  test("[MUST-FAIL] with no field, an imperative in the gap's text still does not make it a write goal", async () => {
    for (const created of [[STEP], []]) {
      const judgedBefore = judgeCalls;
      const v = await verifyGoalReached(GOAL, ["gapDecomposition"], "walk(1 steps): decomposeGap", "- gapDecomposition: {...}", undefined, undefined, undefined, undefined, pool(created), { persistedWrites: [], targets: ["gapDecomposition"] }, "walk");
      expect(v).not.toBeNull();
      expect(v?.reason ?? "").not.toContain("write-goal-no-artifact");
      expect(v?.reason ?? "").not.toContain("gap-investigation");
      expect((v as { abstain?: unknown } | null)?.abstain).toBeUndefined();
      expect(judgeCalls).toBe(judgedBefore + 1);
    }
  });

  test("[MUST-FAIL] the exemption is keyed on the target shapes, not on the goal's prose", async () => {
    // phrased as an investigation, but its target is not a gapDecomposition: the prose no longer exempts it
    const byProse = await verifyGoalReached(GOAL, ["llm_completion"], "walk(1 steps)", "- llm_completion: {...}", undefined, undefined, undefined, undefined, [], { persistedWrites: [], targets: ["llm_completion"] }, "walk");
    expect(byProse?.reason ?? "").toContain("write-goal-no-artifact");
  });

  test("[MUST-FAIL] field present, gap store unreadable: the exemption is taken, warned, and the judge grades", async () => {
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); realWarn(...a); };
    const judgedBefore = judgeCalls;
    let v: Awaited<ReturnType<Gate>>;
    try {
      // the child the run reports is not served by the stub (404), so the store read throws and the oracle decides nothing
      v = await dispatchContext.run({ dispatchId: "d-store-down", decomposeGapId: X }, () => verifyGoalReached(GOAL, ["gapDecomposition"], "walk(1 steps): decomposeGap", "- gapDecomposition: {...}", undefined, undefined, undefined, undefined, pool(["ghost-step"]), { persistedWrites: [], targets: ["gapDecomposition"] }, "walk"));
    } finally { console.warn = realWarn; }
    expect(v!?.reason ?? "").not.toContain("write-goal-no-artifact");
    expect(judgeCalls).toBe(judgedBefore + 1);
    expect(warned.some((l) => l.includes(`gap ${X}: the gap store could not be read`) && l.includes("the write gate is skipped"))).toBe(true);
  });

  test("[CONTROL] the exemption is narrow: a no-field investigation that targets a mutation shape still meets the write gate", async () => {
    const v = await verifyGoalReached(GOAL, ["gapDecomposition"], "walk(1 steps): decomposeGap", "- gapDecomposition: {...}", undefined, undefined, undefined, undefined, pool([STEP]), { persistedWrites: [], targets: ["gapDecomposition", "substrateGap_write"] }, "walk");
    expect(v?.reason ?? "").toContain("write-goal-no-artifact");
  });

  test("[WIRING] the gap gate sits above the write gate", () => {
    const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const gap = SRC.indexOf("const gi = await verifyGapInvestigationOutcome(");
    const write = SRC.indexOf("const _wg = judge.reachGate(judgeInputs.reachInput({ goal, writeEvidence,");
    expect(gap).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(0);
    expect(gap).toBeLessThan(write);
  });
});
